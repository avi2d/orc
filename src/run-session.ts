import { Data, Effect, FileSystem, Path } from "effect"
import { sumPiUsage, type PiTokenUse } from "./pi"

export class OrcRunError extends Data.TaggedError("OrcRunError")<{
  readonly message: string
}> {}

export const describeCause = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)

export interface CapturedSession {
  readonly file: string | null
  readonly usage: PiTokenUse | null
  readonly jsonl: string | null
}

export const noSession: CapturedSession = { file: null, usage: null, jsonl: null }

export const readSession = (
  run: {
    readonly fs: FileSystem.FileSystem
    readonly path: Path.Path
    readonly projectDir: string
    readonly hostSessionsDir: string
  },
  storage: { readonly readHostSession: (cwd: string, id: string) => Promise<string | undefined> } | undefined,
  sessionId: string | null
): Effect.Effect<CapturedSession, OrcRunError> =>
  Effect.gen(function*() {
    if (sessionId === null || storage === undefined) {
      return noSession
    }
    const jsonl = yield* Effect.tryPromise({
      try: () => storage.readHostSession(run.projectDir, sessionId),
      catch: (cause) => new OrcRunError({ message: "orc: cannot read the Pi session: " + describeCause(cause) })
    })
    if (jsonl === undefined) {
      return noSession
    }
    const relative = yield* findCapturedSession(run.fs, run.path, run.hostSessionsDir, sessionId)
    const file = relative === null ? null : run.path.join(run.hostSessionsDir, relative)
    return { file, usage: sumPiUsage(jsonl), jsonl }
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
