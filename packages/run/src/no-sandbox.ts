import { BunServices } from "@effect/platform-bun"
import { Data, Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { NoSandboxProvider } from "@ai-hero/sandcastle"
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox"

export interface NoSandboxDirs {
  readonly piSessionDir: string
  readonly hostSessionsDir: string
}

export interface NoSandboxEnv {
  readonly GIT_CONFIG_GLOBAL: string
  readonly PI_CODING_AGENT_SESSION_DIR: string
}

// Sandcastle's per-run setup writes safe.directory and the commit identity with `git config --global`, which on the host would rewrite the operator's own config.
// No capture copies the session out of a no-sandbox run, so Pi writes it one folder below where the captured sessions sit.
export const noSandboxEnv = (dirs: NoSandboxDirs): NoSandboxEnv => ({
  GIT_CONFIG_GLOBAL: dirs.piSessionDir + "/gitconfig",
  PI_CODING_AGENT_SESSION_DIR: dirs.hostSessionsDir + "/host"
})

class NoSandboxProviderError extends Data.TaggedError("NoSandboxProviderError")<{
  readonly message: string
}> {}

interface NoSandboxExecOptions {
  readonly onLine?: ((line: string) => void) | undefined
  readonly cwd?: string | undefined
  readonly stdin?: string | undefined
}

interface NoSandboxExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

interface NoSandboxCreateOptions {
  readonly worktreePath: string
  readonly env: Record<string, string>
}

interface NoSandboxHandle {
  readonly worktreePath: string
  readonly exec: (command: string, options?: NoSandboxExecOptions) => Promise<NoSandboxExecResult>
  readonly close: () => Promise<void>
}

type NoSandboxCreate = (options: NoSandboxCreateOptions) => Promise<NoSandboxHandle>

export interface NoSandboxSandboxProvider extends NoSandboxProvider {
  readonly create: NoSandboxCreate
}

const signalExitCode = 128

const tailLimit = 65536

const appendTail = (current: string, chunk: string): string => {
  const next = current + chunk
  return next.length > tailLimit ? next.slice(next.length - tailLimit) : next
}

const isNoSandboxCreate = (value: unknown): value is NoSandboxCreate => typeof value === "function"

const execProgram = (
  processEnv: Record<string, string>,
  fallbackCwd: string,
  command: string,
  options: NoSandboxExecOptions | undefined
): Effect.Effect<NoSandboxExecResult, NoSandboxProviderError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const stdin: ChildProcess.CommandInput = options?.stdin === undefined
        ? "ignore"
        : Stream.fromIterable([new TextEncoder().encode(options.stdin)])
      const handle = yield* spawner.spawn(
        ChildProcess.make("sh", ["-c", command], { cwd: options?.cwd ?? fallbackCwd, env: processEnv, extendEnv: false, stdin })
      )
      const onLine = options?.onLine
      if (onLine === undefined) {
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
            handle.exitCode.pipe(
              Effect.map((exit): number => exit),
              Effect.orElseSucceed(() => signalExitCode)
            )
          ],
          { concurrency: "unbounded" }
        )
        return { stdout, stderr, exitCode }
      }
      let stdoutTail = ""
      let stderrTail = ""
      const [, , streamedExit] = yield* Effect.all(
        [
          handle.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.tap((line) =>
              Effect.sync(() => {
                stdoutTail = appendTail(stdoutTail === "" ? "" : stdoutTail + "\n", line)
                onLine(line)
              })
            ),
            Stream.runDrain
          ),
          handle.stderr.pipe(
            Stream.decodeText(),
            Stream.tap((text) =>
              Effect.sync(() => {
                stderrTail = appendTail(stderrTail, text)
              })
            ),
            Stream.runDrain
          ),
          handle.exitCode.pipe(
            Effect.map((exit): number => exit),
            Effect.orElseSucceed(() => signalExitCode)
          )
        ],
        { concurrency: "unbounded" }
      )
      return { stdout: stdoutTail, stderr: stderrTail, exitCode: streamedExit }
    })
  ).pipe(
    Effect.mapError((cause) => new NoSandboxProviderError({ message: `orc no-sandbox provider: exec failed: ${String(cause)}` }))
  )

const fixedExec = (processEnv: Record<string, string>, fallbackCwd: string) =>
  (command: string, options?: NoSandboxExecOptions): Promise<NoSandboxExecResult> =>
    Effect.runPromise(execProgram(processEnv, fallbackCwd, command, options).pipe(Effect.provide(BunServices.layer)))

export const noSandboxProvider = (dirs: NoSandboxDirs, operatorEnv: Readonly<Record<string, string | undefined>>): NoSandboxSandboxProvider => {
  const base = noSandbox({ env: { ...noSandboxEnv(dirs) } })
  const candidate: unknown = "create" in base ? base.create : undefined
  const baseCreate: NoSandboxCreate | undefined = isNoSandboxCreate(candidate) ? candidate : undefined
  const create: NoSandboxCreate = (createOptions) =>
    Effect.runPromise(
      (baseCreate === undefined
        ? Effect.fail(new NoSandboxProviderError({ message: "orc no-sandbox provider: the no-sandbox handle has no create" }))
        : Effect.tryPromise({
          try: () => baseCreate(createOptions),
          catch: (cause) => new NoSandboxProviderError({ message: `orc no-sandbox provider: the sandbox failed to start: ${String(cause)}` })
        })).pipe(
        Effect.map((handle) => {
          const processEnv: Record<string, string> = {}
          for (const [key, value] of Object.entries(operatorEnv)) {
            if (value !== undefined) {
              processEnv[key] = value
            }
          }
          for (const [key, value] of Object.entries(createOptions.env)) {
            processEnv[key] = value
          }
          return {
            ...handle,
            exec: fixedExec(processEnv, handle.worktreePath)
          }
        })
      )
    )
  return { ...base, create }
}
