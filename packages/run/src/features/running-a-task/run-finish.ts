import { Effect, FileSystem } from "effect"
import { driveNoMistakes, waitForAnswers, type AllowWord, type OpenQuestion, type QuestionAnswer } from "../../entities/review-gate/index"
import { ciVerdictLine, type CiVerdict, type DirectPrRecord, openDirectPr, type PullRequestOpener, readCiVerdict } from "../../entities/pull-request/index"
import { branchCommits, runGit } from "../../shared/process/index"
import { OrcRunError } from "../../shared/lib/index"
import type { LongSessionCounts, PiTokenUse } from "../../entities/agent/index"
import { prBodyFileName, type ChecksRoundSummary, type HistoryRun, type OrcRunCommit, type OrcRunReport, type RecordedFixAttempt } from "./run-record"
import { ciWaitingQuestionId, type RunCheckpoints, type SandboxOps } from "./run-ops"
import { recordOpenAsks } from "./history-write"
import { reviewSentence, reviewAtHead } from "./review-turn"

export const finishAfterChecks = (run: HistoryRun, base: { readonly runId: string; readonly runDir: string; readonly branch: string; readonly agentPath: string; readonly agentSource: string; readonly model: string; readonly sessionId: string | null; readonly sessionFile: string | null; readonly tokens: PiTokenUse | null; readonly sessionSize: LongSessionCounts | null; readonly markerVerified: boolean; readonly implementPassed: boolean; readonly prLink: null; readonly noMistakes: null }, commits: Array<OrcRunCommit>, rounds: Array<ChecksRoundSummary>, fixes: Array<RecordedFixAttempt>, allow: ReadonlyArray<AllowWord>, answers: ReadonlyArray<QuestionAnswer>, checkpoints: RunCheckpoints, runAgent: SandboxOps["runAgent"], priorDir: string | null): Effect.Effect<OrcRunReport, OrcRunError> =>
  Effect.gen(function*() {
    const checked = "Pi made " + commits.length.toString() + (commits.length === 1 ? " commit" : " commits") + " on " + run.branch + (rounds.at(-1)?.passed === true ? ", and the checks passed. " : ". No local checks ran. ")
    const settled = { ...base, commits, checksRounds: rounds, fixes, fixAttempts: fixes.length }
    if (run.delivery.kind === "direct-PR") {
      const review = yield* reviewAtHead(run, runAgent, run.delivery.reviewer, priorDir)
      const pr = yield* openPullRequest(run, run.delivery.opener, rounds, checkpoints)
      const reviewed = checked + reviewSentence(review)
      if (pr.status !== "opened") {
        return { ...settled, completed: false, waitingOnCi: false, prLink: pr.prLink, endReason: reviewed + pr.result }
      }
      const ci = yield* ciVerdictOfHead(run, run.delivery.opener, pr.prLink)
      if (ci.kind === "pending") {
        yield* recordOpenAsks(checkpoints.questionAsked, run.asks, { name: "pr", attempt: 1 }, [ciWaitingQuestion(ci, pr.prLink)])
      }
      return { ...settled, completed: ci.kind === "passed", waitingOnCi: ci.kind === "pending", prLink: pr.prLink, endReason: reviewed + pr.result + " " + ciVerdictLine(ci) }
    }
    yield* checkpoints.noMistakesStart(new Date().toISOString())
    const waitSeconds = run.answerWaitSeconds ?? 0
    const waiting = waitSeconds === 0 ? {} : { waitForAnswers: waitForAnswers(run.runDir, waitSeconds, "no-mistakes") }
    const noMistakes = yield* driveNoMistakes({ runner: run.delivery.runner, taskFile: run.taskPath, runDir: run.runDir, allow, answers, ...waiting }).pipe(
      Effect.provideService(FileSystem.FileSystem, run.fs)
    )
    yield* checkpoints.noMistakesDone(noMistakes)
    return { ...settled, completed: noMistakes.status === "passed", waitingOnCi: false, prLink: noMistakes.prLink, noMistakes, endReason: checked + noMistakes.result }
  })

const ciWaitingQuestion = (ci: Extract<CiVerdict, { readonly kind: "pending" }>, prLink: string): OpenQuestion => ({
  id: ciWaitingQuestionId,
  text: "GitHub CI has not finished on " + ci.headSha + " for " + prLink + ": " + ci.reason + ". The PR stays open while the run waits on CI."
})

const ciVerdictOfHead = (run: HistoryRun, opener: PullRequestOpener, prLink: string): Effect.Effect<CiVerdict> =>
  Effect.gen(function*() {
    const head = yield* runGit(run.spawner, run.git, ["rev-parse", run.branch], run.worktreeDir).pipe(
      Effect.map((parsed) => parsed.exitCode === 0 ? parsed.stdout.trim() : ""),
      Effect.orElseSucceed(() => "")
    )
    if (head === "") {
      return { kind: "pending", headSha: run.branch, waiting: [], reason: "orc could not read the head commit of " + run.branch }
    }
    return yield* readCiVerdict(opener.checkRuns, prLink, head)
  })

const prBody = (subjects: ReadonlyArray<string>, rounds: ReadonlyArray<ChecksRoundSummary>): string => {
  const passed = rounds.at(-1)?.checks.map((check) => check.name) ?? []
  const closing = passed.length === 0
    ? "orc opened this PR without local checks or no-mistakes. GitHub CI decides completion.\n"
    : "orc opened this PR after " + passed.join(", ") + " passed, without no-mistakes.\n"
  return subjects.length === 0 ? closing : subjects.map((subject) => "- " + subject).join("\n") + "\n\n---\n\n" + closing
}

const openPullRequest = (
  run: HistoryRun,
  opener: PullRequestOpener,
  rounds: ReadonlyArray<ChecksRoundSummary>,
  checkpoints: RunCheckpoints
): Effect.Effect<DirectPrRecord, OrcRunError> =>
  Effect.gen(function*() {
    yield* checkpoints.pullRequestStart(new Date().toISOString())
    const head = yield* runGit(run.spawner, run.git, ["log", "-1", "--format=%s", run.branch], run.worktreeDir).pipe(
      Effect.map((logged) => logged.stdout.trim()),
      Effect.orElseSucceed(() => "")
    )
    const listed = yield* branchCommits(run.spawner, run.git, run.branch, run.projectDir).pipe(Effect.orElseSucceed(() => [] as Array<OrcRunCommit>))
    const subjects = listed.map((commit) => commit.subject.trim()).filter((subject) => subject !== "")
    const bodySubjects = subjects.length > 0 ? subjects : (head !== "" ? [head] : [])
    const bodyFile = run.path.join(run.runDir, prBodyFileName)
    yield* run.fs.writeFileString(bodyFile, prBody(bodySubjects, rounds)).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot write " + bodyFile + ": " + String(cause) }))
    )
    const pr = yield* openDirectPr(opener, run.branch, head !== "" ? head : run.branch, bodyFile)
    yield* checkpoints.pullRequestDone(pr)
    return pr
  })
