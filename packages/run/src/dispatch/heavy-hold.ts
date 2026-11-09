import { Console, Effect } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { ensureGroup } from "./runner"
import { RunnerError } from "./runner-error"
import { pueue } from "./runner-exec"

export const heavyHoldLabel = "orc-heavy-hold"

export const heavyHoldBypass = (group: string): string =>
  "orc holds the " + group + " queue slot for this sandbox run"

const acquireHold = (group: string): Effect.Effect<string, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    yield* ensureGroup(group, ["--parallel", "1"])
    const printed = yield* pueue(["add", "--group", group, "--label", heavyHoldLabel, "--print-task-id", "--escape", "--", "sleep", "86400"])
    const id = printed.trim()
    if (!/^[0-9]+$/.test(id)) {
      return yield* new RunnerError({ detail: "pueue refused the heavy hold: " + id })
    }
    yield* pueue(["wait", "-q", "-s", "running", id]).pipe(
      Effect.onError(() => pueue(["remove", id]).pipe(Effect.ignore))
    )
    yield* Console.log("orc: holding the " + group + " queue slot for the sandbox run")
    return id
  })

const releaseHold = (id: string): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> =>
  pueue(["kill", id]).pipe(
    Effect.ignore,
    Effect.andThen(pueue(["wait", "-q", id]).pipe(Effect.ignore)),
    Effect.andThen(pueue(["remove", id]).pipe(Effect.ignore))
  )

export const withHeavyHold = <A, E, R>(
  group: string,
  use: () => Effect.Effect<A, E, R>
): Effect.Effect<A, E | RunnerError, R | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.acquireUseRelease(acquireHold(group), () => use(), (id) => releaseHold(id))
