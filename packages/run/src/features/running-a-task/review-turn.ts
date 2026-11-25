import { Effect, Option, Result, Schema } from "effect"
import { finalReplyText, type AgentFile } from "../../entities/agent/index"
import { runGit } from "../../shared/process/index"
import type { HistoryRun } from "./run-record"
import { OrcRunError } from "../../shared/lib/index"
import type { AgentRunResult, SandboxOps } from "./run-ops"

const ReviewFinding = Schema.Struct({
  id: Schema.String,
  file: Schema.String,
  line: Schema.NullOr(Schema.Int),
  severity: Schema.Literals(["blocker", "major", "minor"]),
  action: Schema.String,
  description: Schema.String
})

const ReviewFindings = Schema.Array(ReviewFinding)

type ReviewFinding = typeof ReviewFinding.Type

const ReviewOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("passed"), findings: ReviewFindings, file: Schema.String }),
  Schema.Struct({ status: Schema.Literal("failed"), reason: Schema.String })
])

export type ReviewOutcome = typeof ReviewOutcome.Type

const ReviewCheckpoint = Schema.Struct({ head: Schema.String, outcome: ReviewOutcome })
const decodeCheckpoint = Schema.decodeUnknownOption(Schema.fromJsonString(ReviewCheckpoint))
const checkpointFileName = "review-checkpoint.json"

const reviewFileName = "review.json"

const maxReviewAnswers = 2

const decodeFindings = Schema.decodeUnknownResult(Schema.fromJsonString(ReviewFindings))

const readOnlyTools = ["read", "grep", "find", "ls"]

const readFindings = (reply: string | null): Result.Result<ReadonlyArray<ReviewFinding>, string> => {
  if (reply === null) {
    return Result.fail("the reply did not stop cleanly")
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
    : run.fs.readFileString(sessionFile).pipe(Effect.map(finalReplyText), Effect.orElseSucceed(() => null))

export const runReviewTurn = (
  run: Pick<HistoryRun, "fs" | "path" | "runDir" | "piSessionDir" | "spawner" | "git" | "projectDir" | "branch">,
  runAgent: SandboxOps["runAgent"],
  reviewer: AgentFile
): Effect.Effect<ReviewOutcome> =>
  Effect.gen(function*() {
    const diffed = yield* readDiff(run).pipe(Effect.result)
    if (Result.isFailure(diffed)) {
      return { status: "failed", reason: diffed.failure.message }
    }
    const first = reviewPrompt(reviewer, run.path.join(run.piSessionDir, "task.md"), diffed.success)
    let prompt = first
    let resumeSession: string | null = null
    let problem = ""
    for (let answer = 1; answer <= maxReviewAnswers; answer += 1) {
      const result: Result.Result<AgentRunResult, OrcRunError> = yield* runAgent({ agent: { ...reviewer, tools: readOnlyTools }, prompt, logFile: "review-" + answer.toString() + ".log", resumeSession, withoutAsks: true, onSession: () => Effect.void }).pipe(Effect.result)
      if (Result.isFailure(result)) {
        return { status: "failed", reason: result.failure.message }
      }
      const findings = readFindings(yield* readReply(run, result.success.sessionFile))
      if (Result.isSuccess(findings)) {
        const file = run.path.join(run.runDir, reviewFileName)
        const written = yield* run.fs.writeFileString(file, JSON.stringify(findings.success, null, 2) + "\n").pipe(Effect.result)
        return Result.isSuccess(written)
          ? { status: "passed", findings: findings.success, file }
          : { status: "failed", reason: "orc cannot write " + file + ": " + written.failure.message }
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
): Effect.Effect<ReviewOutcome, OrcRunError> =>
  Effect.gen(function*() {
    const headOfBranch = () => runGit(run.spawner, run.git, ["rev-parse", "--verify", run.branch], run.worktreeDir).pipe(
      Effect.map((result) => result.exitCode === 0 ? result.stdout.trim() : ""),
      Effect.orElseSucceed(() => "")
    )
    const head = yield* headOfBranch()
    const saved = priorDir === null ? null : yield* run.fs.readFileString(run.path.join(priorDir, checkpointFileName)).pipe(Effect.orElseSucceed(() => null))
    const decoded = saved === null ? Option.none() : decodeCheckpoint(saved)
    const outcome = head !== "" && Option.isSome(decoded) && decoded.value.head === head
      ? decoded.value.outcome
      : yield* runReviewTurn(run, runAgent, reviewer)
    const after = yield* headOfBranch()
    if (head !== "" && head === after) {
      const file = run.path.join(run.runDir, checkpointFileName)
      yield* run.fs.writeFileString(file, JSON.stringify({ head, outcome }) + "\n").pipe(
        Effect.mapError((cause) => new OrcRunError({ message: "orc cannot write " + file + ": " + String(cause) }))
      )
    }
    return outcome
  })

export const reviewSentence = (outcome: ReviewOutcome): string =>
  outcome.status === "passed"
    ? "The review turn recorded " + outcome.findings.length.toString() + (outcome.findings.length === 1 ? " finding" : " findings") + " in " + outcome.file + ". "
    : "The review turn failed, so the review did not pass: " + outcome.reason.replace(/\s+/g, " ").trim() + ". "
