import { Effect, Result } from "effect"
import { finalReplyText, type AgentFile } from "../../entities/agent/index"
import type { HistoryRun } from "./run-record"
import { readDiff, readOnlyTools } from "./review-turn"
import type { AgentRunResult, SandboxOps } from "./run-ops"

export type DiagramResult
  = { readonly kind: "mermaid"; readonly chart: string }
  | { readonly kind: "none" }

export const parseDiagramReply = (reply: string | null): DiagramResult => {
  if (reply === null) {
    return { kind: "none" }
  }
  const trimmed = reply.trim()
  if (trimmed.toLowerCase() === "no diagram") {
    return { kind: "none" }
  }
  const chart = /```mermaid[ \t]*\r?\n([\s\S]*?)```/.exec(trimmed)?.[1]?.trim() ?? ""
  return chart === "" ? { kind: "none" } : { kind: "mermaid", chart }
}

const diagramPrompt = (taskFile: string, diffFile: string): string =>
  [
    "You draw one diagram of the change on the current branch of this repository for the PR that ships it.",
    "The task sits in " + taskFile + ".",
    "The branch diff sits in " + diffFile + ".",
    "Read the task and the diff, and read every changed file in full.",
    "Change no file, make no commit and run no command that writes anything.",
    "When the change alters a flow, a structure or a boundary, print one ```mermaid flowchart block that explains it, with nothing before or after the fence.",
    "When no picture explains the change better than words, print only: no diagram"
  ].join("\n")

const readReply = (
  run: Pick<HistoryRun, "fs">,
  result: Result.Result<AgentRunResult, unknown>
): Effect.Effect<string | null> => {
  if (Result.isFailure(result) || result.success.sessionFile === null) {
    return Effect.succeed(null)
  }
  const sessionFile = result.success.sessionFile
  return run.fs.readFileString(sessionFile).pipe(
    Effect.map((jsonl) => finalReplyText(jsonl)),
    Effect.catchTag("PlatformError", () => Effect.succeed<string | null>(null))
  )
}

export const runDiagramTurn = (
  run: Pick<HistoryRun, "fs" | "path" | "runDir" | "piSessionDir" | "spawner" | "git" | "projectDir" | "branch">,
  runAgent: SandboxOps["runAgent"],
  reviewer: AgentFile
): Effect.Effect<DiagramResult> =>
  Effect.gen(function*() {
    const diffed = yield* readDiff(run).pipe(Effect.result)
    if (Result.isFailure(diffed)) {
      return { kind: "none" } as const
    }
    const prompt = diagramPrompt(run.path.join(run.piSessionDir, "task.md"), diffed.success)
    const result = yield* runAgent({
      agent: { ...reviewer, tools: readOnlyTools },
      prompt,
      logFile: "diagram.log",
      resumeSession: null,
      withoutAsks: true,
      onSession: () => Effect.void
    }).pipe(Effect.result)
    return parseDiagramReply(yield* readReply(run, result))
  })
