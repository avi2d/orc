import { Effect, Result } from "effect"
import type { AgentFile } from "../../entities/agent/index"
import type { HistoryRun } from "./run-record"
import { readDiff, readOnlyTools, readReply } from "./review-turn"
import type { SandboxOps } from "./run-ops"

export type DiagramResult
  = { readonly kind: "mermaid"; readonly chart: string }
  | { readonly kind: "none" }

export const parseDiagramReply = (reply: string | null): DiagramResult => {
  const chart = reply === null ? "" : /```mermaid[ \t]*\r?\n([\s\S]*?)```/.exec(reply)?.[1]?.trim() ?? ""
  return chart === "" ? { kind: "none" } : { kind: "mermaid", chart }
}

const diagramPrompt = (diffFile: string): string =>
  [
    "You draw one diagram of the change on the current branch of this repository for the PR that ships it.",
    "The branch diff sits in " + diffFile + ".",
    "Read the diff and every changed file in full. Do not read task files or include private details.",
    "Start with Why: followed by one short sentence explaining the change from the diff.",
    "Change no file, make no commit and run no command that writes anything.",
    "When the change alters a flow, a structure or a boundary, follow with one ```mermaid flowchart block that explains it.",
    "Otherwise, follow with: no diagram"
  ].join("\n")

export interface DiagramTurnResult {
  readonly diagram: DiagramResult
  readonly why: string | null
}

export const runDiagramTurn = (
  run: Pick<HistoryRun, "fs" | "path" | "runDir" | "piSessionDir" | "spawner" | "git" | "projectDir" | "branch">,
  runAgent: SandboxOps["runAgent"],
  reviewer: AgentFile
): Effect.Effect<DiagramTurnResult> =>
  Effect.gen(function*() {
    const diffed = yield* readDiff(run).pipe(Effect.result)
    if (Result.isFailure(diffed)) {
      return { diagram: { kind: "none" }, why: null } as const
    }
    const prompt = diagramPrompt(diffed.success)
    const result = yield* runAgent({
      agent: { ...reviewer, tools: readOnlyTools },
      prompt,
      logFile: "diagram.log",
      resumeSession: null,
      withoutAsks: true,
      onSession: () => Effect.void
    }).pipe(Effect.result)
    if (Result.isFailure(result)) {
      return { diagram: { kind: "none" }, why: null } as const
    }
    const reply = yield* readReply(run, result.success.sessionFile)
    const why = reply?.match(/^Why:[ \t]*(.+)$/m)?.[1]?.trim() || null
    return { diagram: parseDiagramReply(reply), why }
  })
