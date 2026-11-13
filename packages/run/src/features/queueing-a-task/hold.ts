import { Console, DateTime, Duration, Effect, FileSystem, Option, type Path } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { heldExpiry, heldTokenDir, releaseHeldToken } from "../../entities/token/index"
import { fileKeyOf, labelOf } from "../../entities/backlog/index"
import { openDatabase, runById, runsForBranch, type RunRecord } from "../../entities/run-history/index"
import { RunnerError } from "../../shared/process/index"
import { type Command } from "../../shared/process/index"
import { tokenLive } from "../../entities/token/index"

const pollSeconds = 5

const waitForLiveToken = (home: string, task: string, label?: string | null): Effect.Effect<DateTime.Utc, RunnerError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const key = fileKeyOf(home, task, labelOf(home, task, label))
    let told = false
    while (true) {
      const expiry = yield* heldExpiry(home, key)
      if (Option.isNone(expiry)) {
        return yield* new RunnerError({ detail: "no token is held for " + task + " in " + heldTokenDir(home, key) })
      }
      if (tokenLive(expiry.value, yield* DateTime.now)) {
        return expiry.value
      }
      if (!told) {
        yield* Console.log(task + " waits for a fresh token from the machine that runs the beat: the one held here runs out at " + DateTime.formatIso(expiry.value))
        told = true
      }
      yield* Effect.sleep(Duration.seconds(pollSeconds))
    }
  })

// The run stays in the holder's process group, so a pueue kill reaches it along with the holder.
const runOnce = (run: Command): Effect.Effect<number, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const [program, ...args] = run
    const handle = yield* spawner.spawn(ChildProcess.make(program, args, { detached: false, stdin: "ignore", stdout: "inherit", stderr: "inherit" }))
    return yield* handle.exitCode
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) => new RunnerError({ detail: run[0] + " did not finish: " + error.message }))
  )

const resumeEnvPrefix = "ORC_DISPATCH_RESUME_RUN="

const resumePinOf = (run: Command): string | null => {
  const found = run.find((entry) => entry.startsWith(resumeEnvPrefix))
  return found === undefined ? null : found.slice(resumeEnvPrefix.length)
}

const withResumePin = (run: Command, pin: string): Command => {
  const [first = "", ...rest] = run.map((entry) => entry.startsWith(resumeEnvPrefix) ? resumeEnvPrefix + pin : entry)
  return [first, ...rest]
}

const taskFileOf = (run: Command): string | null => {
  const at = run.findIndex((entry) => entry === "run")
  const file = at === -1 ? undefined : run[at + 1]
  return file === undefined || file === "" || file.startsWith("-") ? null : file
}

const ownAttemptId = (
  runs: ReadonlyArray<RunRecord>,
  pin: string
): RunRecord | null => {
  const latest = runs[0]
  if (latest === undefined || latest.id === pin || !runs.some((run) => run.id === pin)) {
    return null
  }
  return latest
}

const advancedPin = (
  home: string,
  run: Command,
  holderStartMillis: number
): Effect.Effect<Command, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const pin = resumePinOf(run)
    const file = taskFileOf(run)
    if (pin === null || pin === "" || file === null) {
      return run
    }
    const next = yield* Effect.acquireUseRelease(
      openDatabase(home),
      (db) =>
        Effect.gen(function*() {
          const expected = yield* runById(db, pin).pipe(Effect.orElseSucceed(() => null))
          if (expected === null) {
            return null
          }
          const runs = yield* runsForBranch(db, expected.project, expected.branch).pipe(Effect.orElseSucceed((): ReadonlyArray<RunRecord> => []))
          const latest = ownAttemptId(runs, pin)
          if (latest === null || Number.isNaN(Date.parse(latest.started)) || Date.parse(latest.started) < holderStartMillis) {
            return null
          }
          const fs = yield* FileSystem.FileSystem
          const holderText = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => null))
          const latestText = holderText === null ? null : yield* fs.readFileString(latest.taskFile).pipe(Effect.orElseSucceed(() => null))
          return holderText !== null && holderText === latestText ? latest.id : null
        }),
      (db) => Effect.sync(() => db.close())
    ).pipe(Effect.orElseSucceed(() => null))
    return next === null ? run : withResumePin(run, next)
  })

// Pi reads the token once per process, so a run whose token ran out fails, and only a fresh process takes the renewed one.
export const holdRun = (
  task: string,
  run: Command,
  home: string,
  label?: string | null
): Effect.Effect<string, RunnerError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> => {
  const key = fileKeyOf(home, task, labelOf(home, task, label))
  const holderStartMillis = Date.now()
  return Effect.gen(function*() {
    let current = run
    while (true) {
      const startedWith = yield* waitForLiveToken(home, task, label)
      const exitCode = yield* runOnce(current)
      if (exitCode === 0) {
        return "the run of " + task + " finished"
      }
      if (tokenLive(startedWith, yield* DateTime.now)) {
        return yield* new RunnerError({ detail: "the run of " + task + " exited " + exitCode })
      }
      current = yield* advancedPin(home, current, holderStartMillis)
      yield* Console.log("the run of " + task + " exited " + exitCode + " as its token ran out at " + DateTime.formatIso(startedWith) + ", so it resumes on a fresh one")
    }
  }).pipe(Effect.ensuring(releaseHeldToken(home, key)))
}
