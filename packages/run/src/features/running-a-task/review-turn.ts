import { Effect, Option, Result, Schema } from "effect"
import { finalReplyText, type AgentFile } from "../../entities/agent/index"
import { runGit } from "../../shared/process/index"
import type { HistoryRun } from "./run-record"
import { OrcRunError } from "../../shared/lib/index"
import type { AgentRunResult, SandboxOps } from "./run-ops"
import { decodeOrcReviewFindings, RecordedReview, ReviewFindings, type ReviewFinding, type ReviewOutcome, type ReviewAtHeadOutcome } from "./review-outcome"

const ReviewCheckpoint = Schema.Struct({ head: Schema.String, outcome: RecordedReview })
const decodeCheckpoint = Schema.decodeUnknownOption(Schema.fromJsonString(ReviewCheckpoint))
export const checkpointFileName = "review-checkpoint.json"

const reviewFileName = "review.json"

const maxReviewAnswers = 2

const decodeFindings = Schema.decodeUnknownResult(Schema.fromJsonString(ReviewFindings))

const readOnlyTools = ["read", "grep", "find", "ls"]

const readFindings = (reply: string | null, mode: "direct-PR" | "orc"): Result.Result<ReadonlyArray<ReviewFinding>, string> => {
  if (reply === null) {
    return Result.fail("the reply did not stop cleanly")
  }
  if (mode === "orc") {
    const decoded = decodeOrcReviewFindings(reply.trim())
    return Result.isFailure(decoded) ? Result.fail(decoded.failure.name + ": " + decoded.failure.message) : Result.succeed(decoded.success)
  }
  const decoded = decodeFindings(reply.trim())
  return Result.isFailure(decoded) ? Result.fail(decoded.failure.message) : Result.succeed(decoded.success)
}

const diffFileName = "diff.md"

const readDiff = (
  run: Pick<HistoryRun, "fs" | "path" | "piSessionDir" | "spawner" | "git" | "projectDir" | "branch">
): Effect.Effect<string, OrcRunError> =>
  Effect.gen(function*() {
    const diffed = yield* runGit(run.spawner, run.git, ["diff", "HEAD..." + run.branch, "--"], run.projectDir)
    if (diffed.exitCode !== 0) {
      return yield* new OrcRunError({ message: "orc cannot read the branch diff: " + diffed.stderr.trim() })
    }
    const file = run.path.join(run.piSessionDir, diffFileName)
    yield* run.fs.writeFileString(file, diffed.stdout).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc cannot write " + file + ": " + String(cause) }))
    )
    return file
  })

const reviewPrompt = (reviewer: AgentFile, taskFile: string, diffFile: string): string =>
  [reviewer.body, "", "The task sits in " + taskFile + ".", "The branch diff sits in " + diffFile + "."].join("\n")

const rerunPrompt = (problem: string): string =>
  [
    "orc could not read your findings: " + problem + ".",
    "Print only the findings JSON array again, with nothing before or after it and no code fence."
  ].join("\n")

const readReply = (run: Pick<HistoryRun, "fs">, sessionFile: string | null): Effect.Effect<string | null> =>
  sessionFile === null
    ? Effect.succeed(null)
    : run.fs.readFileString(sessionFile).pipe(Effect.map(finalReplyText), Effect.catchTag("PlatformError", () => Effect.succeed(null)))

const recordReview = (
  run: Pick<HistoryRun, "fs" | "path" | "runDir">,
  findings: ReadonlyArray<ReviewFinding>,
  attempt: number
): Effect.Effect<ReviewOutcome> =>
  Effect.gen(function*() {
    const file = run.path.join(run.runDir, attempt === 1 ? reviewFileName : "review-" + attempt.toString() + ".json")
    const written = yield* run.fs.writeFileString(file, JSON.stringify(findings, null, 2) + "\n").pipe(Effect.result)
    return Result.isSuccess(written)
      ? { status: "passed", findings, file }
      : { status: "failed", reason: "orc cannot write " + file + ": " + written.failure.message }
  })

export const runReviewTurn = (
  run: Pick<HistoryRun, "fs" | "path" | "runDir" | "piSessionDir" | "spawner" | "git" | "projectDir" | "branch">,
  runAgent: SandboxOps["runAgent"],
  reviewer: AgentFile,
  mode: "direct-PR" | "orc" = "direct-PR",
  attempt = 1
): Effect.Effect<ReviewOutcome> =>
  Effect.gen(function*() {
    const diffed = yield* readDiff(run).pipe(Effect.result)
    if (Result.isFailure(diffed)) {
      return { status: "failed", reason: diffed.failure.message }
    }
    const first = reviewPrompt(reviewer, run.path.join(run.piSessionDir, "task.md"), diffed.success) + (mode === "orc" ? "\nFor this review, severity must be error, warning or info, instead of any other severity names." : "")
    let prompt = first
    let resumeSession: string | null = null
    let problem = ""
    for (let answer = 1; answer <= maxReviewAnswers; answer += 1) {
      const result: Result.Result<AgentRunResult, OrcRunError> = yield* runAgent({ agent: { ...reviewer, tools: readOnlyTools }, prompt, logFile: "review-" + answer.toString() + ".log", resumeSession, withoutAsks: true, onSession: () => Effect.void }).pipe(Effect.result)
      if (Result.isFailure(result)) {
        return { status: "failed", reason: result.failure.message }
      }
      const findings = readFindings(yield* readReply(run, result.success.sessionFile), mode)
      if (Result.isSuccess(findings)) {
        return yield* recordReview(run, findings.success, attempt)
      }
      problem = findings.failure
      resumeSession = result.success.sessionFile ?? resumeSession
      prompt = resumeSession === null ? first + "\n" + rerunPrompt(problem) : rerunPrompt(problem)
    }
    return { status: "failed", reason: "the reviewer gave " + maxReviewAnswers.toString() + " answers orc could not read, the last because " + problem }
  })

export const reviewAtHead = (
  run: Pick<HistoryRun, "fs" | "path" | "runDir" | "piSessionDir" | "spawner" | "git" | "projectDir" | "worktreeDir" | "branch">,
  runAgent: SandboxOps["runAgent"],
  reviewer: AgentFile,
  priorDir: string | null
): Effect.Effect<ReviewAtHeadOutcome> =>
  Effect.gen(function*() {
    const head = yield* runGit(run.spawner, run.git, ["rev-parse", "--verify", run.branch], run.worktreeDir).pipe(
      Effect.map((result) => result.exitCode === 0 ? result.stdout.trim() : ""),
      Effect.catchTag("OrcRunError", () => Effect.succeed(""))
    )
    const saved = priorDir === null ? null : yield* run.fs.readFileString(run.path.join(priorDir, checkpointFileName)).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(null)))
    const decoded = saved === null ? Option.none() : decodeCheckpoint(saved)
    const reusable = head !== "" && Option.isSome(decoded) && decoded.value.head === head ? decoded.value : null
    const reusedFrom = reusable !== null && priorDir !== null ? run.path.basename(priorDir) : null
    const outcome = reusable !== null
      ? yield* recordReview(run, reusable.outcome.findings, 1)
      : yield* runReviewTurn(run, runAgent, reviewer)
    if (outcome.status === "passed" && head !== "") {
      const file = run.path.join(run.runDir, checkpointFileName)
      yield* run.fs.writeFileString(file, JSON.stringify({ head, outcome }) + "\n").pipe(Effect.result)
    }
    return { ...outcome, reusedFrom }
  })

export const reviewSentence = (outcome: ReviewOutcome): string =>
  outcome.status === "passed"
    ? "The review turn recorded " + outcome.findings.length.toString() + (outcome.findings.length === 1 ? " finding" : " findings") + " in " + outcome.file + ". "
    : "The review turn failed, so the review did not pass: " + outcome.reason.replace(/\s+/g, " ").trim() + ". "
