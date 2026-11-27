import { Effect, FileSystem } from "effect"
import { driveNoMistakes, waitForAnswers, type AllowWord, type QuestionAnswer } from "../../entities/review-gate/index"
import { type DirectPrRecord, openDirectPr, type PullRequestOpener } from "../../entities/pull-request/index"
import { branchCommits, runGit } from "../../shared/process/index"
import { OrcRunError } from "../../shared/lib/index"
import type { AgentFile, LongSessionCounts, PiTokenUse } from "../../entities/agent/index"
import { prBodyFileName, type ChecksRoundSummary, type HistoryRun, type OrcRunCommit, type OrcRunReport, type RecordedFixAttempt } from "./run-record"
import type { RunCheckpoints, SandboxOps } from "./run-ops"
import { reviewSentence, reviewAtHead, runReviewTurn } from "./review-turn"
import type { ReviewOutcome, ReviewFinding } from "./review-outcome"
import { beatReadsChecks } from "./checks"

export const finishAfterChecks = (run: HistoryRun, base: { readonly runId: string; readonly runDir: string; readonly branch: string; readonly agentPath: string; readonly agentSource: string; readonly model: string; readonly sessionId: string | null; readonly sessionFile: string | null; readonly tokens: PiTokenUse | null; readonly sessionSize: LongSessionCounts | null; readonly markerVerified: boolean; readonly implementPassed: boolean; readonly prLink: null; readonly noMistakes: null }, commits: Array<OrcRunCommit>, rounds: Array<ChecksRoundSummary>, fixes: Array<RecordedFixAttempt>, allow: ReadonlyArray<AllowWord>, answers: ReadonlyArray<QuestionAnswer>, checkpoints: RunCheckpoints, runAgent: SandboxOps["runAgent"], priorDir: string | null, orcReview?: ReviewOutcome): Effect.Effect<OrcRunReport, OrcRunError> =>
  Effect.gen(function*() {
    const checked = "Pi made " + commits.length.toString() + (commits.length === 1 ? " commit" : " commits") + " on " + run.branch + (rounds.at(-1)?.passed === true ? ", and the checks passed. " : ". No local checks ran. ")
    const settled = { ...base, commits, checksRounds: rounds, fixes, fixAttempts: fixes.length }
    if (run.delivery.kind === "orc") {
      const review = orcReview ?? (yield* reviewOrc(run, run.delivery.reviewer, checkpoints, runAgent, 1))
      const reviewed = checked + reviewSentence(review)
      if (review.status === "failed") {
        return { ...settled, completed: false, prLink: null, endReason: reviewed }
      }
      const pr = yield* openPullRequest(run, run.delivery.opener, rounds, checkpoints, review)
      return { ...settled, completed: pr.status === "opened", prLink: pr.prLink, endReason: reviewed + pr.result }
    }
    if (run.delivery.kind === "direct-PR") {
      const reviewStarted = new Date().toISOString()
      yield* checkpoints.reviewStart(run.delivery.reviewer, 1, reviewStarted)
      const review = yield* reviewAtHead(run, runAgent, run.delivery.reviewer, priorDir)
      yield* checkpoints.reviewDone(run.delivery.reviewer, 1, review, reviewStarted, new Date().toISOString())
      const pr = yield* openPullRequest(run, run.delivery.opener, rounds, checkpoints, review)
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

export const reviewOrc = (run: HistoryRun, reviewer: AgentFile, checkpoints: RunCheckpoints, runAgent: SandboxOps["runAgent"], attempt: number): Effect.Effect<ReviewOutcome, OrcRunError> =>
  Effect.gen(function*() {
    const started = new Date().toISOString()
    yield* checkpoints.reviewStart(reviewer, attempt, started)
    const review = yield* runReviewTurn(run, runAgent, reviewer, "orc")
    yield* checkpoints.reviewDone(reviewer, attempt, { ...review, reusedFrom: null }, started, new Date().toISOString())
    return review
  })

const findingLine = (finding: ReviewFinding): string =>
  "- " + finding.severity + " `" + finding.id + "` at `" + finding.file + (finding.line === null ? "" : ":" + finding.line.toString()) + "`: " + finding.description + " Action: " + finding.action

const reviewSection = (review: ReviewOutcome): string =>
  review.status === "failed"
    ? "\nThe review turn failed, so this PR lists no review findings.\n"
    : review.findings.length === 0
    ? "\nThe review found nothing.\n"
    : "\nOpen review findings:\n" + review.findings.map(findingLine).join("\n") + "\n"

export const prBody = (subjects: ReadonlyArray<string>, passed: ReadonlyArray<string>, review: ReviewOutcome): string => {
  const closing = passed.length === 0
    ? "orc opened this PR without local checks or no-mistakes. " + beatReadsChecks + "\n"
    : "orc opened this PR after " + passed.join(", ") + " passed, without no-mistakes.\n"
  return (subjects.length === 0 ? closing : subjects.map((subject) => "- " + subject).join("\n") + "\n\n---\n\n" + closing) + reviewSection(review)
}

const openPullRequest = (
  run: HistoryRun,
  opener: PullRequestOpener,
  rounds: ReadonlyArray<ChecksRoundSummary>,
  checkpoints: RunCheckpoints,
  review: ReviewOutcome
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
    const bodyFile = run.path.join(run.runDir, prBodyFileName)
    yield* run.fs.writeFileString(bodyFile, prBody(bodySubjects, rounds.at(-1)?.checks.map((check) => check.name) ?? [], review)).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot write " + bodyFile + ": " + String(cause) }))
    )
    const pr = yield* openDirectPr(opener, run.branch, head !== "" ? head : run.branch, bodyFile)
    yield* checkpoints.pullRequestDone(pr)
    return pr
  })
