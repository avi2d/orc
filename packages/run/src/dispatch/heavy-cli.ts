import { Console, Effect, type FileSystem } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { heavyBinDir } from "./heavy"
import { ensureHeavySetup } from "./heavy-setup"
import { checkHeavy, ensureHeavyWatch, formatCheck, watchOnce } from "./heavy-watch"
import { type Command, type RunnerError } from "./runner"
import type { DispatchArgs } from "./args"

export type HeavyVerb = Extract<DispatchArgs, { readonly kind: "HeavyPath" | "HeavyCheck" | "HeavyWatch" | "HeavyWatchOnce" }>

export const startHeavyWatch = (home: string, orc: Command, command: string): Effect.Effect<void, never, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  ensureHeavySetup(home).pipe(
    Effect.flatMap(() => ensureHeavyWatch(home, orc)),
    Effect.flatMap((line) => line === null ? Effect.void : Console.log(line)),
    Effect.catchTag("RunnerError", (error) => Console.error(command + " queued no heavy watch: " + error.detail))
  )

export interface HeavyPlace {
  readonly home: string
  readonly self: Command
}

export const runHeavy = (args: HeavyVerb, place: HeavyPlace): Effect.Effect<void, RunnerError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    switch (args.kind) {
      case "HeavyPath": {
        yield* ensureHeavySetup(place.home)
        yield* Console.log(heavyBinDir(place.home))
        break
      }
      case "HeavyCheck": {
        const check = yield* checkHeavy(place.home)
        yield* Console.log(args.json ? JSON.stringify(check) : formatCheck(check))
        break
      }
      case "HeavyWatch": {
        yield* startHeavyWatch(place.home, place.self, "orc heavy watch")
        break
      }
      case "HeavyWatchOnce": {
        const report = yield* watchOnce(place.home)
        yield* Console.log("heavy watch: " + String(report.stale.length) + " stale, " + String(report.old.length) + " old, " + String(report.alerts.length) + " alerts, " + String(report.slips.length) + " slips")
        break
      }
    }
  })
