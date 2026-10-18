import { Data, Effect, FileSystem, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export class NonoProviderError extends Data.TaggedError("NonoProviderError")<{
  readonly reason: string
}> {}

export type Spawner = ChildProcessSpawner.ChildProcessSpawner["Service"]

export interface HostCommandResult {
  readonly stdout: string
  readonly stdoutBytes: Uint8Array
  readonly stderr: string
  readonly exitCode: number
}

export const runHostCommand = (
  spawner: Spawner,
  command: ChildProcess.Command,
  options?: {
    readonly onLine?: ((line: string) => void) | undefined
  }
): Effect.Effect<HostCommandResult, NonoProviderError> =>
  Effect.scoped(Effect.gen(function*() {
    const onLine = options?.onLine
    const stdoutChunks: Array<Uint8Array> = []
    const handle = yield* spawner.spawn(command)
    const [, stderr, exitCode] = yield* Effect.all([
      handle.stdout.pipe(
        Stream.tap((chunk) => Effect.sync(() => stdoutChunks.push(chunk))),
        Stream.decodeText(),
        Stream.splitLines,
        Stream.tap((line) => onLine === undefined ? Effect.void : Effect.sync(() => onLine(line))),
        Stream.runDrain
      ),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      handle.exitCode
    ], { concurrency: "unbounded" })
    const code: number = exitCode
    const stdoutBytes = Buffer.concat(stdoutChunks)
    return { stdout: new TextDecoder().decode(stdoutBytes), stdoutBytes, stderr, exitCode: code }
  })).pipe(
    Effect.mapError(
      (cause) => new NonoProviderError({ reason: `orc nono provider: command failed to run: ${String(cause)}` })
    )
  )

// The caller's env PATH may name tools inside the copy, so a host binary is found on the host's own PATH.
export const resolveHostBinary = (fs: FileSystem.FileSystem, name: string): Effect.Effect<string, NonoProviderError> => {
  const found = Bun.which(name)
  return found === null
    ? Effect.fail(new NonoProviderError({ reason: `orc nono provider: ${name} is not on the host PATH` }))
    : fs.realPath(found).pipe(
      Effect.mapError((cause) => new NonoProviderError({ reason: `orc nono provider: cannot resolve ${name}: ${String(cause)}` }))
    )
}

export const resolveDeveloperDir = (
  spawner: Spawner,
  fs: FileSystem.FileSystem,
  env: Record<string, string>
): Effect.Effect<string | null, NonoProviderError> =>
  process.platform !== "darwin" ? Effect.succeed(null) : Effect.gen(function*() {
    const xcodeSelect = yield* resolveHostBinary(fs, "xcode-select")
    const result = yield* runHostCommand(spawner, ChildProcess.make(xcodeSelect, ["-p"], { env, extendEnv: false }))
    if (result.exitCode !== 0) {
      return null
    }
    return yield* fs.realPath(result.stdout.trim()).pipe(
      Effect.mapError((cause) => new NonoProviderError({ reason: `orc nono provider: cannot resolve the developer folder: ${String(cause)}` }))
    )
  })
