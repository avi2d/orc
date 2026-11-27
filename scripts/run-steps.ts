import { constants } from "node:os"
import { BunServices } from "@effect/platform-bun"
import { Console, Data, Effect, FileSystem, type Path, type PlatformError } from "effect"

class StepError extends Data.TaggedError("StepError")<{
  readonly message: string
}> {}

export const root = Bun.fileURLToPath(new URL("..", import.meta.url))

interface Command {
  readonly command: ReadonlyArray<string>
  readonly cwd?: string
  readonly env?: Record<string, string | undefined>
}

interface FileWork {
  readonly fileWork: Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem>
}

export type Step = Command | FileWork

const fileWork = (work: (fs: FileSystem.FileSystem) => Effect.Effect<void, PlatformError.PlatformError>): Step => ({
  fileWork: Effect.gen(function*() {
    yield* work(yield* FileSystem.FileSystem)
  })
})

export const copyFile = (from: string, to: string): Step => fileWork((fs) => fs.copyFile(root + from, root + to))

export const copyTree = (from: string, to: string): Step => fileWork((fs) => fs.copy(root + from, root + to))

export const removeTree = (target: string): Step => fileWork((fs) => fs.remove(root + target, { recursive: true, force: true }))

const signalNumbers: ReadonlyMap<string, number> = new Map(Object.entries(constants.signals))

// A shell reports a step a signal ended as 128 plus the signal number.
const shellExitCode = (exitCode: number | null, signal: string | number | null): number =>
  exitCode ?? 128 + (typeof signal === "number" ? signal : signalNumbers.get(signal ?? "") ?? 0)

const notFound = 127

const fileWorkFailed = 1

const runFileWork = (step: FileWork): Effect.Effect<number, never, FileSystem.FileSystem> =>
  step.fileWork.pipe(
    Effect.as(0),
    Effect.catchTag("PlatformError", (error) => Console.error(error.message).pipe(Effect.as(fileWorkFailed)))
  )

const runCommand = (step: Command): Effect.Effect<number, StepError> => {
  const [program = ""] = step.command
  return Effect.try({
    try: () => Bun.spawn([...step.command], { cwd: root + (step.cwd ?? ""), env: step.env ?? process.env, stdio: ["inherit", "inherit", "inherit"] }),
    catch: () => new StepError({ message: program + ": not found" })
  }).pipe(
    Effect.flatMap((child) => Effect.promise(() => child.exited).pipe(Effect.as(child))),
    Effect.map((child) => shellExitCode(child.exitCode, child.signalCode))
  )
}

const runStep = (step: Step): Effect.Effect<number, StepError, FileSystem.FileSystem> =>
  "fileWork" in step ? runFileWork(step) : runCommand(step)

const runInOrder = (steps: ReadonlyArray<Step>): Effect.Effect<number, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    for (const step of steps) {
      const code = yield* runStep(step)
      if (code !== 0) return code
    }
    return 0
  }).pipe(Effect.catchTag("StepError", (error) => Console.error(error.message).pipe(Effect.as(notFound))))

// A package.json script hands its own arguments to its last command, so the last step gets them.
const withArguments = (steps: ReadonlyArray<Step>, extra: ReadonlyArray<string>): ReadonlyArray<Step> => {
  const last = steps.at(-1)
  return last === undefined || "fileWork" in last ? steps : [...steps.slice(0, -1), { ...last, command: [...last.command, ...extra] }]
}

export const runPlannedStepsAndExit = (planned: Effect.Effect<ReadonlyArray<Step>, never, FileSystem.FileSystem | Path.Path>): void => {
  const program = planned.pipe(
    Effect.flatMap((steps) => runInOrder(withArguments(steps, process.argv.slice(2)))),
    Effect.tap((code) => Effect.sync(() => {
      process.exitCode = code
    })),
    Effect.provide(BunServices.layer)
  )
  void Effect.runPromise(program)
}

export const runStepsAndExit = (steps: ReadonlyArray<Step>): void => runPlannedStepsAndExit(Effect.succeed(steps))
