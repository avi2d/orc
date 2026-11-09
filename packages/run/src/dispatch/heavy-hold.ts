import { Console, Effect, Option, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { PueueStatus } from "./pueue-status"
import { ensureGroup } from "./runner"
import { RunnerError } from "./runner-error"
import { decodeJson, pueue } from "./runner-exec"

export const heavyHoldLabel = "orc-heavy-hold"

export const heavyHoldBypass = (group: string): string =>
  "orc holds the " + group + " queue slot for this sandbox run"

const HoldState = Schema.Struct({
  tasks: Schema.Record(Schema.String, Schema.Struct({
    id: Schema.Int,
    label: Schema.NullOr(Schema.String),
    group: Schema.String,
    status: Schema.Unknown
  }))
})

const aliveStatus = (status: unknown): boolean =>
  Option.match(Schema.decodeUnknownOption(PueueStatus)(status), {
    onNone: () => true,
    onSome: (decoded) => "Queued" in decoded || "Running" in decoded || "Paused" in decoded || "Stashed" in decoded || "Locked" in decoded
  })

const sweepStaleHolds = (group: string): Effect.Effect<void, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  pueue(["status", "--json"]).pipe(
    Effect.flatMap((text) => decodeJson(text, HoldState, "pueue status --json")),
    Effect.flatMap((state) => Effect.forEach(
      Object.values(state.tasks).filter((task) => task.group === group && task.label === heavyHoldLabel && !aliveStatus(task.status)),
      (task) => pueue(["remove", String(task.id)]).pipe(Effect.ignore),
      { discard: true }
    ))
  )

const acquireHold = (group: string): Effect.Effect<string, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    yield* ensureGroup(group, ["--parallel", "1"])
    yield* sweepStaleHolds(group)
    const printed = yield* pueue(["add", "--group", group, "--label", heavyHoldLabel, "--print-task-id", "--escape", "--",
      "sh", "-c", 'while kill -0 "$1" 2>/dev/null; do sleep 5; done', "orc-heavy-exit", String(process.pid)])
    const id = printed.trim()
    if (!/^[0-9]+$/.test(id)) {
      return yield* new RunnerError({ detail: "pueue refused the heavy hold: " + id })
    }
    return id
  })

const waitRunning = (id: string): Effect.Effect<void, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  pueue(["wait", "-q", "-s", "running", id]).pipe(
    Effect.asVoid,
    Effect.onError(() => pueue(["remove", id]).pipe(Effect.ignore))
  )

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
  Effect.acquireUseRelease(
    acquireHold(group),
    (id) => waitRunning(id).pipe(
      Effect.andThen(Console.log("orc: holding the " + group + " queue slot for the sandbox run")),
      Effect.andThen(use())
    ),
    (id) => releaseHold(id)
  )
