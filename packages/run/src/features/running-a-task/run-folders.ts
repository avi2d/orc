import { Console, Effect, type FileSystem, type Path } from "effect"
import { readFailure } from "../../shared/config/index"
import { OrcRunError } from "../../shared/lib/index"
import type { Database } from "bun:sqlite"
import { openQuestionsForRun, type OrcRunReport } from "../../entities/run-history/index"
import type { HistoryRun } from "./run-record"

export const runInstructions = (fs: FileSystem.FileSystem, path: Path.Path, cwd: string, named: string | undefined): Effect.Effect<string | null, OrcRunError> =>
  Effect.gen(function*() {
    if (named === undefined) {
      return null
    }
    const file = path.resolve(cwd, named)
    const info = yield* fs.stat(file).pipe(Effect.orElseSucceed(() => null))
    if (info?.type !== "File") {
      return yield* new OrcRunError({ message: "orc run found no instructions file at " + file })
    }
    yield* Console.log("orc run loaded the instructions in " + file)
    return file
  })

const copyInstructions = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  piSessionDir: string,
  instructionsFile: string | null
): Effect.Effect<string | null, OrcRunError> =>
  Effect.gen(function*() {
    if (instructionsFile === null) {
      return null
    }
    const copy = path.join(piSessionDir, "instructions.md")
    yield* fs.readFileString(instructionsFile).pipe(
      Effect.flatMap((text) => fs.writeFileString(copy, text)),
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot copy the instructions file " + instructionsFile + ": " + String(cause) }))
    )
    return copy
  })

const piAgentDirOf = (path: Path.Path, runDir: string): string => path.join(runDir, "session", "agent")

// A failed removal leaves only disk use behind, so it is logged and the run keeps its ending.
export const dropPiAgentDir = (fs: FileSystem.FileSystem, path: Path.Path, runDir: string): Effect.Effect<void> => {
  const dir = piAgentDirOf(path, runDir)
  return fs.remove(dir, { recursive: true, force: true }).pipe(
    Effect.catch((cause) => Console.log("orc: cannot remove the Pi agent folder " + dir + " after the run ended: " + String(cause)))
  )
}

// A failed read counts as parked, so the folder stays whenever the open questions are unknown.
const endsParked = (db: Database, runId: string, report: OrcRunReport): Effect.Effect<boolean> =>
  report.completed
    ? Effect.succeed(false)
    : openQuestionsForRun(db, runId).pipe(Effect.map((open) => open.length > 0), Effect.orElseSucceed(() => true))

export const dropEndedPiAgentDir = (db: Database, run: Pick<HistoryRun, "fs" | "path" | "runDir" | "runId">, report: OrcRunReport): Effect.Effect<void> =>
  Effect.gen(function*() {
    if (report.waitingOnCi || (yield* endsParked(db, run.runId, report))) {
      return
    }
    yield* dropPiAgentDir(run.fs, run.path, run.runDir)
  })

export interface RunFolders {
  readonly runDir: string
  readonly piSessionDir: string
  readonly piAgentDir: string
  readonly hostSessionsDir: string
  readonly taskPath: string
  readonly sandboxTaskPath: string
  readonly instructionsPath: string | null
}

export const prepareRunFolders = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  runDir: string,
  taskFile: string,
  instructionsFile: string | null
): Effect.Effect<RunFolders, OrcRunError> =>
  Effect.gen(function*() {
    const piSessionDir = path.join(runDir, "session")
    const piAgentDir = piAgentDirOf(path, runDir)
    const hostSessionsDir = path.join(runDir, "sessions")
    yield* fs.makeDirectory(piAgentDir, { recursive: true }).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot create the run folder " + runDir + ": " + String(cause) }))
    )
    yield* fs.makeDirectory(hostSessionsDir, { recursive: true }).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot create the sessions folder: " + String(cause) }))
    )
    const taskText = yield* fs.readFileString(taskFile).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot read the task file " + taskFile + ": " + readFailure(cause) }))
    )
    const taskPath = path.join(runDir, "task.md")
    const sandboxTaskPath = path.join(piSessionDir, "task.md")
    yield* fs.writeFileString(taskPath, taskText).pipe(
      Effect.andThen(() => fs.writeFileString(sandboxTaskPath, taskText)),
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot write the task file: " + String(cause) }))
    )
    const instructionsPath = yield* copyInstructions(fs, path, piSessionDir, instructionsFile)
    return { runDir, piSessionDir, piAgentDir, hostSessionsDir, taskPath, sandboxTaskPath, instructionsPath }
  })
