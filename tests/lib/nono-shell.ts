import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { agentCommand, textInput } from "../../packages/run/src/agent-exec"
import type { CommandResult } from "../../packages/run/src/agent-exec"
import { runHostCommand } from "../../packages/run/src/host"
import { type NonoExecOptions, openNonoExec } from "../../packages/run/src/nono-exec"

export interface NonoShellRun {
  readonly cwd?: string
  readonly stdin?: string
  readonly onLine?: (line: string) => void
  readonly signal?: AbortSignal
}

export type NonoShell = (command: string, run?: NonoShellRun) => Promise<CommandResult>

export const withNonoShell = <A>(options: NonoExecOptions, body: (shell: NonoShell) => Promise<A>): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const exec = yield* openNonoExec(options)
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const services = yield* Effect.context()
    const shell: NonoShell = (command, run = {}) =>
      Effect.runPromiseWith(services)(
        runHostCommand(spawner, agentCommand({ ...exec, cwd: run.cwd ?? exec.cwd }, ["sh", "-c", command], run.stdin === undefined ? "ignore" : textInput(run.stdin)), { onLine: run.onLine }).pipe(
          Effect.map(({ stdout, stderr, exitCode }) => ({ stdout, stderr, exitCode }))
        ),
        { signal: run.signal }
      )
    return yield* Effect.promise(() => body(shell))
  })).pipe(Effect.provide(BunServices.layer)))

export const runNonoShell = (options: NonoExecOptions, command: string, run?: NonoShellRun): Promise<CommandResult> =>
  withNonoShell(options, (shell) => shell(command, run))

export const nonoOpenError = (options: NonoExecOptions): Promise<unknown> =>
  Effect.runPromise(
    Effect.scoped(openNonoExec(options)).pipe(
      Effect.as<unknown>(null),
      Effect.catch((cause) => Effect.succeed<unknown>(cause)),
      Effect.provide(BunServices.layer)
    )
  )
