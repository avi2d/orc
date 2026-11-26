import { Duration, Effect, Predicate } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { spawnedQuiet } from "../../shared/process/index"

export type AccountReading =
  | { readonly account: string; readonly kind: "usable"; readonly remainingPercent: number; readonly resetsAt?: string }
  | { readonly account: string; readonly kind: "unusable"; readonly reason: string }

export type CommandFailureCause = "command-missing" | "exit" | "timeout" | "no-json" | "spawn"

type CommandRun =
  | { readonly kind: "printed"; readonly document: unknown }
  | { readonly kind: "failed"; readonly cause: CommandFailureCause; readonly reason: string }

const quotaSeconds = 15

const failed = (cause: CommandFailureCause, reason: string): CommandRun => ({ kind: "failed", cause, reason })

export const runQuotaCommand = (
  command: readonly [string, ...Array<string>]
): Effect.Effect<CommandRun, never, ChildProcessSpawner.ChildProcessSpawner> => {
  const [program, ...args] = command
  const named = "the quota command " + program
  return Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const [stdout, exitCode] = yield* spawnedQuiet(spawner, program, args)
    if (exitCode !== 0) {
      return failed("exit", named + " exited " + exitCode)
    }
    return yield* Effect.try((): CommandRun => ({ kind: "printed", document: JSON.parse(stdout) })).pipe(
      Effect.catchTag("UnknownError", () => Effect.succeed(failed("no-json", named + " printed no JSON")))
    )
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: Duration.seconds(quotaSeconds),
      orElse: () => Effect.succeed(failed("timeout", named + " ran past " + quotaSeconds + " seconds"))
    }),
    Effect.catch((error) =>
      Effect.succeed(
        Predicate.isTagged(error.reason, "NotFound")
          ? failed("command-missing", named + " is not installed on PATH")
          : failed("spawn", named + " did not run: " + error.message)
      )
    )
  )
}
