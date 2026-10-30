import { Console, DateTime, Duration, Effect, FileSystem, Option } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { heldExpiry, heldTokenDir, releaseHeldToken } from "./held-token"
import { type Command, RunnerError } from "./runner"
import { tokenLive } from "./token"

const pollSeconds = 5

// pueue kill sends SIGKILL to the task's process group, which no finalizer outlives, so a process in its own session removes the folder once the holder is gone.
const guardScript = "while kill -0 \"$1\" 2>/dev/null; do sleep 1; done; rm -rf -- \"$2\""

const guardFolder = (holder: number, dir: string): Effect.Effect<void, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make("sh", ["-c", guardScript, "orc-token-guard", String(holder), dir], {
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore"
    }))
    yield* Effect.asVoid(handle.unref)
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) => new RunnerError({ detail: "the token guard did not start: " + error.message }))
  )

const waitForLiveToken = (home: string, task: string): Effect.Effect<DateTime.Utc, RunnerError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    let told = false
    while (true) {
      const expiry = yield* heldExpiry(home, task)
      if (Option.isNone(expiry)) {
        return yield* new RunnerError({ detail: "no token is held for " + task + " in " + heldTokenDir(home, task) })
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
  home: string
): Effect.Effect<string, RunnerError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    yield* guardFolder(process.pid, heldTokenDir(home, task))
    while (true) {
      const startedWith = yield* waitForLiveToken(home, task)
      const exitCode = yield* runOnce(run)
      if (exitCode === 0) {
        return "the run of " + task + " finished"
      }
      if (tokenLive(startedWith, yield* DateTime.now)) {
        return yield* new RunnerError({ detail: "the run of " + task + " exited " + exitCode })
      }
      yield* Console.log("the run of " + task + " exited " + exitCode + " as its token ran out at " + DateTime.formatIso(startedWith) + ", so it resumes on a fresh one")
    }
  }).pipe(Effect.ensuring(releaseHeldToken(home, task)))
