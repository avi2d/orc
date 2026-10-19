import { Data, Effect, FileSystem, Path } from "effect"
import { sumPiUsage } from "./pi"

export class OrcRunError extends Data.TaggedError("OrcRunError")<{
  readonly message: string
}> {}

export const describeCause = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)

export const readSession = (
  run: {
    readonly fs: FileSystem.FileSystem
    readonly path: Path.Path
    readonly projectDir: string
    readonly hostSessionsDir: string
  },
  storage: { readonly readHostSession: (cwd: string, id: string) => Promise<string | undefined> } | undefined,
  sessionId: string | null
): Effect.Effect<{ readonly file: string | null; readonly inputTokens: number; readonly outputTokens: number; readonly jsonl: string | null }, OrcRunError> =>
  Effect.gen(function*() {
    if (sessionId === null || storage === undefined) {
      return { file: null, inputTokens: 0, outputTokens: 0, jsonl: null }
    }
    const jsonl = yield* Effect.tryPromise({
      try: () => storage.readHostSession(run.projectDir, sessionId),
      catch: (cause) => new OrcRunError({ message: "orc: cannot read the Pi session: " + describeCause(cause) })
    })
    if (jsonl === undefined) {
      return { file: null, inputTokens: 0, outputTokens: 0, jsonl: null }
    }
    const usage = sumPiUsage(jsonl)
    const relative = yield* findCapturedSession(run.fs, run.path, run.hostSessionsDir, sessionId)
    const file = relative === null ? null : run.path.join(run.hostSessionsDir, relative)
    return { file, inputTokens: usage.input, outputTokens: usage.output, jsonl }
  })

const findCapturedSession = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  hostSessionsDir: string,
  sessionId: string
): Effect.Effect<string | null, OrcRunError> =>
  Effect.gen(function*() {
    const dirs = yield* fs.readDirectory(hostSessionsDir)
    for (const dir of dirs) {
      const files = yield* fs.readDirectory(path.join(hostSessionsDir, dir))
      const found = files.find((entry) => entry.endsWith(sessionId + ".jsonl"))
      if (found !== undefined) {
        return path.join(dir, found)
      }
    }
    return null
  }).pipe(
    Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot list the sessions folder: " + String(cause) }))
  )
