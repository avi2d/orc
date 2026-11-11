import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import type { CommandResult } from "../../packages/run/src/agent-exec"
import type { AgentRun, SandboxOps } from "../../packages/run/src/run-loop"
import { OrcRunError } from "../../packages/run/src/shared/lib/run-session"

export interface FakeAgentResult {
  readonly sessionId?: string
  readonly sessionFile?: string
  readonly exitCode?: number
  readonly commits: ReadonlyArray<{ readonly sha: string }>
}

export type FakeAgent = (run: AgentRun, sessionsDir: string) => Promise<FakeAgentResult>

export type FakeCheck = (command: string) => Promise<CommandResult>

const failure = (cause: unknown): OrcRunError => new OrcRunError({ message: cause instanceof Error ? cause.message : String(cause) })

const sessionFileFor = async (sessionsDir: string, sessionId: string): Promise<string | null> => {
  const names = await readdir(sessionsDir).catch(() => [] as Array<string>)
  const name = names.find((entry) => entry.endsWith("_" + sessionId + ".jsonl"))
  return name === undefined ? null : join(sessionsDir, name)
}

const settle = async (result: FakeAgentResult, sessionsDir: string) => ({
  sessionId: result.sessionId ?? null,
  sessionFile: result.sessionFile ?? (result.sessionId === undefined ? null : await sessionFileFor(sessionsDir, result.sessionId)),
  end: { kind: "exited", exitCode: result.exitCode ?? 0 } as const,
  commits: result.commits
})

export const fakeOps = (parts: { readonly runAgent: FakeAgent; readonly execCheck: FakeCheck }, sessionsDir: string): SandboxOps => ({
  runAgent: (run) => Effect.tryPromise({ try: () => parts.runAgent(run, sessionsDir).then((result) => settle(result, sessionsDir)), catch: failure }),
  execCheck: (command) => Effect.tryPromise({ try: () => parts.execCheck(command), catch: failure })
})
