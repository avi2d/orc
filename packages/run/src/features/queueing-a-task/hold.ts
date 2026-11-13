import { Console, DateTime, Duration, Effect, FileSystem, Option, type Path } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { heldExpiry, heldTokenDir, releaseHeldToken } from "../../entities/token/index"
import { fileKeyOf, labelOf } from "../../entities/backlog/index"
import { openDatabase, runById } from "../../entities/run-history/index"
import { newRunId } from "../../shared/lib/index"
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

const attemptEnvPrefix = "ORC_DISPATCH_RUN_ID="

const withAttemptId = (run: Command, attempt: string): Command => {
  if (resumePinOf(run) === null) {
    return run
  }
  const replaced = run.map((entry) => entry.startsWith(attemptEnvPrefix) ? attemptEnvPrefix + attempt : entry)
  if (replaced.some((entry) => entry.startsWith(attemptEnvPrefix))) {
    const [first = "", ...rest] = replaced
    return [first, ...rest]
  }
  const [first = "", ...rest] = run
  return first === "env" ? [first, attemptEnvPrefix + attempt, ...rest] : [first, ...rest]
}

const advancedPin = (
  home: string,
  run: Command,
  attempt: string
): Effect.Effect<Command, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const pin = resumePinOf(run)
    if (pin === null || pin === "" || attempt === "") {
      return run
    }
    const recorded = yield* Effect.acquireUseRelease(
      openDatabase(home),
      (db) => runById(db, attempt).pipe(Effect.orElseSucceed(() => null)),
      (db) => Effect.sync(() => db.close())
    ).pipe(Effect.orElseSucceed(() => null))
    return recorded === null ? run : withResumePin(run, recorded.id)
  })

// Pi reads the token once per process, so a run whose token ran out fails, and only a fresh process takes the renewed one.
export const holdRun = (
  task: string,
  run: Command,
  home: string,
  label?: string | null
): Effect.Effect<string, RunnerError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> => {
  const key = fileKeyOf(home, task, labelOf(home, task, label))
  return Effect.gen(function*() {
    let current = run
    while (true) {
      const attempt = newRunId()
      const startedWith = yield* waitForLiveToken(home, task, label)
      const exitCode = yield* runOnce(withAttemptId(current, attempt))
      if (exitCode === 0) {
        return "the run of " + task + " finished"
      }
      if (tokenLive(startedWith, yield* DateTime.now)) {
        return yield* new RunnerError({ detail: "the run of " + task + " exited " + exitCode })
      }
      current = yield* advancedPin(home, current, attempt)
      yield* Console.log("the run of " + task + " exited " + exitCode + " as its token ran out at " + DateTime.formatIso(startedWith) + ", so it resumes on a fresh one")
    }
  }).pipe(Effect.ensuring(releaseHeldToken(home, key)))
}
