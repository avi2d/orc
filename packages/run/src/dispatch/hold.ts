import { Console, DateTime, Duration, Effect, FileSystem, Option } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { heldExpiry, heldTokenDir, releaseHeldToken } from "./held-token"
import { taskLabel } from "./pueue-status"
import { type Command, RunnerError } from "./runner"
import { tokenLive } from "./token"

const pollSeconds = 5

const tokenKeyOf = (home: string, task: string, label?: string | null): string => {
  const want = label ?? taskLabel(home, task)
  return want === taskLabel(home, task) ? task : encodeURIComponent(want)
}

const waitForLiveToken = (home: string, task: string, label?: string | null): Effect.Effect<DateTime.Utc, RunnerError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const key = tokenKeyOf(home, task, label)
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
        yield* Console.log(task + " waits for a fresh token from the Mac: the one held here runs out at " + DateTime.formatIso(expiry.value))
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

// Pi reads the token once per process, so a run whose token ran out fails, and only a fresh process takes the renewed one.
export const holdRun = (
  task: string,
  run: Command,
  home: string,
  label?: string | null
): Effect.Effect<string, RunnerError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> => {
  const key = tokenKeyOf(home, task, label)
  return Effect.gen(function*() {
    while (true) {
      const startedWith = yield* waitForLiveToken(home, task, label)
      const exitCode = yield* runOnce(run)
      if (exitCode === 0) {
        return "the run of " + task + " finished"
      }
      if (tokenLive(startedWith, yield* DateTime.now)) {
        return yield* new RunnerError({ detail: "the run of " + task + " exited " + exitCode })
      }
      yield* Console.log("the run of " + task + " exited " + exitCode + " as its token ran out at " + DateTime.formatIso(startedWith) + ", so it resumes on a fresh one")
    }
  }).pipe(Effect.ensuring(releaseHeldToken(home, key)))
}
