import { Effect, FileSystem } from "effect"
import { driveNoMistakes, waitForAnswers, type AllowWord, type QuestionAnswer } from "../../entities/review-gate/index"
import { type DirectPrRecord, openDirectPr, type PullRequestOpener } from "../../entities/pull-request/index"
import { branchCommits, runGit } from "../../shared/process/index"
import { OrcRunError } from "../../shared/lib/index"
import type { LongSessionCounts, PiTokenUse } from "../../entities/agent/index"
import { prBodyFileName, type ChecksRoundSummary, type HistoryRun, type OrcRunCommit, type OrcRunReport, type RecordedFixAttempt } from "./run-record"
import { type DiagramTurnResult, runDiagramTurn } from "./diagram-turn"
import type { ReviewEligibility, ReviewerPick, RunCheckpoints, SandboxOps } from "./run-ops"
import { reviewSentence, reviewAtHead, runReviewTurn } from "./review-turn"
import type { ReviewOutcome, ReviewFinding } from "./review-outcome"
import { beatReadsChecks } from "./checks"
import { leftFindings, leftReasonLine, reviewStopReason, type LeftFinding, type ReviewStop } from "./left-findings"
import type { NoReviewerRoom } from "./reviewer-chain"

type OrcLoopEnd =
  | { readonly review: Extract<ReviewOutcome, { readonly status: "failed" }> }
  | {
    readonly review: Extract<ReviewOutcome, { readonly status: "passed" }>
    readonly sentPerRound: ReadonlyArray<ReadonlyArray<ReviewFinding>>
    readonly stop: ReviewStop
    readonly askUserFindings: ReadonlyArray<ReviewFinding>
    readonly eligibility: ReviewEligibility
  }

type ReviewSection =
  | { readonly kind: "failed" }
  | { readonly kind: "unfixed"; readonly findings: ReadonlyArray<ReviewFinding> }
  | { readonly kind: "left"; readonly findings: ReadonlyArray<LeftFinding> }

const unfixedSection = (review: ReviewOutcome): ReviewSection =>
  review.status === "failed" ? { kind: "failed" } : { kind: "unfixed", findings: review.findings }

export const finishAfterChecks = (run: HistoryRun, base: { readonly runId: string; readonly runDir: string; readonly branch: string; readonly agentPath: string; readonly agentSource: string; readonly model: string; readonly sessionId: string | null; readonly sessionFile: string | null; readonly tokens: PiTokenUse | null; readonly sessionSize: LongSessionCounts | null; readonly markerVerified: boolean; readonly implementPassed: boolean; readonly prLink: null; readonly noMistakes: null }, commits: Array<OrcRunCommit>, rounds: Array<ChecksRoundSummary>, fixes: Array<RecordedFixAttempt>, allow: ReadonlyArray<AllowWord>, answers: ReadonlyArray<QuestionAnswer>, checkpoints: RunCheckpoints, runAgent: SandboxOps["runAgent"], priorDir: string | null, orcLoop?: OrcLoopEnd): Effect.Effect<OrcRunReport, OrcRunError> =>
  Effect.gen(function*() {
    const checked = "Pi made " + commits.length.toString() + (commits.length === 1 ? " commit" : " commits") + " on " + run.branch + (rounds.at(-1)?.passed === true ? ", and the checks passed. " : ". No local checks ran. ")
    const settled = { ...base, commits, checksRounds: rounds, fixes, fixAttempts: fixes.length }
    if (run.delivery.kind === "orc") {
      if (orcLoop === undefined) {
        return yield* new OrcRunError({ message: "orc: an orc delivery run reached its PR without the review fix loop" })
      }
      const reviewed = checked + reviewSentence(orcLoop.review)
      if (!("stop" in orcLoop)) {
        return { ...settled, completed: false, prLink: null, endReason: reviewed }
      }
      const pr = yield* openPullRequest(run, run.delivery.opener, drawWithPick(run, run.delivery.reviewer, runAgent, orcLoop.eligibility), rounds, checkpoints, { kind: "left", findings: leftFindings(orcLoop.review.findings, orcLoop.sentPerRound, orcLoop.stop, orcLoop.askUserFindings) })
      return { ...settled, completed: pr.status === "opened", prLink: pr.prLink, endReason: reviewed + "The review fix loop stopped because " + reviewStopReason(orcLoop.stop) + ". " + pr.result }
    }
    if (run.delivery.kind === "direct-PR") {
      const reviewStarted = new Date().toISOString()
      yield* checkpoints.reviewStart(run.delivery.reviewer, 1, reviewStarted)
      const review = yield* reviewAtHead(run, runAgent, run.delivery.reviewer, priorDir)
      yield* checkpoints.reviewDone(run.delivery.reviewer, 1, review, reviewStarted, new Date().toISOString())
      const pr = yield* openPullRequest(run, run.delivery.opener, runDiagramTurn(run, runAgent, run.delivery.reviewer), rounds, checkpoints, unfixedSection(review))
      const reviewed = checked + reviewSentence(review)
      return { ...settled, completed: pr.status === "opened", prLink: pr.prLink, endReason: reviewed + pr.result }
    }
    yield* checkpoints.noMistakesStart(new Date().toISOString())
    const waitSeconds = run.answerWaitSeconds ?? 0
    const waiting = waitSeconds === 0 ? {} : { waitForAnswers: waitForAnswers(run.runDir, waitSeconds, "no-mistakes") }
    const noMistakes = yield* driveNoMistakes({ runner: run.delivery.runner, taskFile: run.taskPath, runDir: run.runDir, allow, answers, ...waiting }).pipe(
      Effect.provideService(FileSystem.FileSystem, run.fs)
    )
    yield* checkpoints.noMistakesDone(noMistakes)
    return { ...settled, completed: noMistakes.status === "passed", prLink: noMistakes.prLink, noMistakes, endReason: checked + noMistakes.result }
  })

export const reviewOrc = (run: HistoryRun, pick: ReviewerPick, checkpoints: RunCheckpoints, runAgent: SandboxOps["runAgent"], attempt: number, eligibility: ReviewEligibility): Effect.Effect<ReviewOutcome, OrcRunError | NoReviewerRoom> =>
  pick(runAgent, eligibility).pipe(
    Effect.flatMap((picked) =>
      Effect.gen(function*() {
        const started = new Date().toISOString()
        yield* checkpoints.reviewStart(picked.reviewer, attempt, started)
        const review = yield* runReviewTurn(run, picked.runAgent, picked.reviewer, "orc", attempt)
        yield* checkpoints.reviewDone(picked.reviewer, attempt, { ...review, reusedFrom: null }, started, new Date().toISOString())
        return review
      })
    ),
    Effect.catchTag("NoReviewerRoom", (error) => {
      const failed: ReviewOutcome = { status: "failed", reason: error.message }
      const at = new Date().toISOString()
      return checkpoints.reviewDone(null, attempt, { ...failed, reusedFrom: null }, at, at).pipe(Effect.andThen(Effect.fail(error)))
    })
  )

const findingLine = (finding: ReviewFinding): string =>
  "- " + finding.severity + " `" + finding.id + "` at `" + finding.file + (finding.line === null ? "" : ":" + finding.line.toString()) + "`: " + finding.description + " Action: " + finding.action

const leftFindingLines = (left: LeftFinding): string =>
  findingLine(left.finding) + "\n  - " + leftReasonLine(left.reason)

export interface PrBodyInput {
  readonly why: string | null
  readonly taskText: string
  readonly subjects: ReadonlyArray<string>
  readonly diagram: string | null
  readonly passed: ReadonlyArray<string>
  readonly review: ReviewSection
}

const checkedSentence = (passed: ReadonlyArray<string>): string =>
  passed.length === 0
    ? "orc opened this PR without local checks or no-mistakes. " + beatReadsChecks
    : "orc opened this PR after " + passed.join(", ") + " passed, without no-mistakes."

const reviewStatusLine = (section: ReviewSection): string =>
  section.kind === "failed"
    ? "The review turn failed, so this PR lists no review findings."
    : section.findings.length === 0
      ? "The review found nothing."
      : "The review left " + section.findings.length.toString() + (section.findings.length === 1 ? " finding" : " findings") + " open, listed below."

const openFindingLines = (section: ReviewSection): string => {
  if (section.kind === "failed" || section.findings.length === 0) {
    return ""
  }
  const lines = section.kind === "unfixed" ? section.findings.map(findingLine) : section.findings.map(leftFindingLines)
  return "\n## Open review findings\n\n" + lines.join("\n") + "\n"
}

const reasonFallback = "No reason was recorded for this change; see What changed."

const normalizedWords = (text: string): Array<string> =>
  text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

const repeatsTaskText = (text: string, taskText: string): boolean => {
  const words = normalizedWords(text)
  const normalizedTask = " " + normalizedWords(taskText).join(" ") + " "
  const copiedRun = words.some((_, index) =>
    index + 8 <= words.length && normalizedTask.includes(" " + words.slice(index, index + 8).join(" ") + " ")
  )
  return copiedRun
}

export const prBody = (input: PrBodyInput): string => {
  const reason = input.why?.trim() ?? ""
  const why = reason === "" || repeatsTaskText(reason, input.taskText) ? reasonFallback : reason
  const chart = input.diagram !== null && repeatsTaskText(input.diagram, input.taskText) ? null : input.diagram
  const changed = input.subjects.length === 0
    ? "No commits landed on the branch."
    : input.subjects.map((subject) => "- " + subject).join("\n")
  const diagram = chart === null ? "" : "\n## How it fits\n\n```mermaid\n" + chart + "\n```\n"
  return "## Why\n\n" + why + "\n\n## What changed\n\n" + changed + "\n" + diagram + "\n## How it was checked\n\n" + checkedSentence(input.passed) + "\n" + reviewStatusLine(input.review) + "\n" + openFindingLines(input.review)
}

const drawWithPick = (run: HistoryRun, pick: ReviewerPick, runAgent: SandboxOps["runAgent"], eligibility: ReviewEligibility): Effect.Effect<DiagramTurnResult> =>
  pick(runAgent, eligibility).pipe(
    Effect.flatMap((picked) => runDiagramTurn(run, picked.runAgent, picked.reviewer)),
    Effect.catchTags({
      NoReviewerRoom: () => Effect.succeed({ diagram: { kind: "none" }, why: null } as const),
      OrcRunError: () => Effect.succeed({ diagram: { kind: "none" }, why: null } as const)
    })
  )

const openPullRequest = (
  run: HistoryRun,
  opener: PullRequestOpener,
  drawDiagram: Effect.Effect<DiagramTurnResult>,
  rounds: ReadonlyArray<ChecksRoundSummary>,
  checkpoints: RunCheckpoints,
  review: ReviewSection
): Effect.Effect<DirectPrRecord, OrcRunError> =>
  Effect.gen(function*() {
    yield* checkpoints.pullRequestStart(new Date().toISOString())
    const head = yield* runGit(run.spawner, run.git, ["log", "-1", "--format=%s", run.branch], run.worktreeDir).pipe(
      Effect.map((logged) => logged.stdout.trim()),
      Effect.catchTag("OrcRunError", () => Effect.succeed(""))
    )
    const listed = yield* branchCommits(run.spawner, run.git, run.branch, run.projectDir).pipe(Effect.catchTag("OrcRunError", () => Effect.succeed([] as Array<OrcRunCommit>)))
    const subjects = listed.map((commit) => commit.subject.trim()).filter((subject) => subject !== "")
    const bodySubjects = subjects.length > 0 ? subjects : (head !== "" ? [head] : [])
    const prepareBody = Effect.gen(function*() {
      const drawn = yield* drawDiagram
      const diagram = drawn.diagram.kind === "mermaid" ? drawn.diagram.chart : null
      const taskText = yield* run.fs.readFileString(run.taskPath).pipe(Effect.catchTag("PlatformError", () => Effect.succeed("")))
      const bodyFile = run.path.join(run.runDir, prBodyFileName)
      yield* run.fs.writeFileString(bodyFile, prBody({ why: drawn.why, taskText, subjects: bodySubjects, diagram, passed: rounds.at(-1)?.checks.map((check) => check.name) ?? [], review })).pipe(
        Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot write " + bodyFile + ": " + String(cause) }))
      )
      return bodyFile
    })
    const pr = yield* openDirectPr(opener, run.branch, head !== "" ? head : run.branch, prepareBody)
    yield* checkpoints.pullRequestDone(pr)
    return pr
  })
