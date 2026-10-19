import { Data, Effect, FileSystem, type Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { type Runtime, runtimeOf, within } from "./nono-profile"

export class NonoProviderError extends Data.TaggedError("NonoProviderError")<{
  readonly message: string
}> {}

export type Spawner = ChildProcessSpawner.ChildProcessSpawner["Service"]

export const resolvePiAgentDir = (
  fs: FileSystem.FileSystem,
  piSessionDir: string,
  configured: string | undefined
): Effect.Effect<Record<string, string>, NonoProviderError> =>
  Effect.gen(function*() {
    const dir = configured ?? `${piSessionDir}/agent`
    if (configured !== undefined) {
      const real = yield* fs.realPath(configured).pipe(
        Effect.mapError((cause) =>
          new NonoProviderError({ message: `orc nono provider: cannot resolve PI_CODING_AGENT_DIR ${configured}: ${String(cause)}` })
        )
      )
      if (!within(piSessionDir, real)) {
        return yield* new NonoProviderError({ message: `orc nono provider: PI_CODING_AGENT_DIR sits outside the session dir: ${configured}` })
      }
    }
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(
      Effect.mapError((cause) =>
        new NonoProviderError({ message: `orc nono provider: cannot create the agent dir ${dir}: ${String(cause)}` })
      )
    )
    return { PI_CODING_AGENT_DIR: dir }
  })

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
      (cause) => new NonoProviderError({ message: `orc nono provider: command failed to run: ${String(cause)}` })
    )
  )

// The caller's env PATH may name tools inside the copy, so a host binary is found on the host's own PATH.
export const resolveHostBinary = (fs: FileSystem.FileSystem, name: string): Effect.Effect<string, NonoProviderError> => {
  const found = Bun.which(name)
  return found === null
    ? Effect.fail(new NonoProviderError({ message: `orc nono provider: ${name} is not on the host PATH` }))
    : fs.realPath(found).pipe(
      Effect.mapError((cause) => new NonoProviderError({ message: `orc nono provider: cannot resolve ${name}: ${String(cause)}` }))
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
      Effect.mapError((cause) => new NonoProviderError({ message: `orc nono provider: cannot resolve the developer folder: ${String(cause)}` }))
    )
  })

// A mise shim is a link to mise itself, so it names no tool and the tool is looked for further along the PATH.
export const resolveRuntime = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  name: string,
  searchPath: string,
  home: string
): Effect.Effect<Runtime | null, NonoProviderError> =>
  Effect.gen(function*() {
    let shimmed = false
    for (const dir of searchPath.split(":").filter((entry) => path.isAbsolute(entry))) {
      const candidate = Bun.which(name, { PATH: dir })
      if (candidate === null) {
        continue
      }
      const real = yield* fs.realPath(candidate).pipe(
        Effect.mapError((cause) => new NonoProviderError({ message: `orc nono provider: cannot resolve ${name}: ${String(cause)}` }))
      )
      if (path.basename(real) === "mise") {
        shimmed = true
        continue
      }
      const runtime = runtimeOf(candidate, real, home)
      if (runtime === null) {
        return yield* new NonoProviderError({
          message: `orc nono provider: ${name} at ${real} is in neither a toolchain folder nor one mise install folder, so the sandbox is granted no folder for it`
        })
      }
      return runtime
    }
    if (shimmed) {
      return yield* new NonoProviderError({
        message: `orc nono provider: ${name} is on the PATH only as a mise shim; put its mise install folder on the PATH`
      })
    }
    return null
  })
