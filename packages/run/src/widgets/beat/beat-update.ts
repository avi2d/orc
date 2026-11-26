import { DateTime, Effect, Option, Schema } from "effect"
import { type UpdateAction, routeUpdateResult, updateLine } from "../../entities/attention/index"
import { platformFailure, readIfPresent, scratchName, writeAtomic } from "../../entities/backlog/index"
import { recordEvent } from "../../entities/events/index"
import { UpdateJson } from "../../entities/orc-update/index"
import { type Machine, ownedBySweep, throughFor } from "../../shared/config/index"
import { withFileClaim } from "../../shared/lib/index"
import { capture, type Command } from "../../shared/process/index"

const hourMillis = 60 * 60 * 1000

const claimHour = Effect.fnUntraced(function*(home: string) {
  const file = home + "/beat-update-checked"
  const claim = yield* withFileClaim(file + ".lock", Effect.gen(function*() {
    const last = yield* readIfPresent(file)
    const now = yield* DateTime.now
    if (last !== null && DateTime.toEpochMillis(now) - Date.parse(last) < hourMillis) {
      return null
    }
    const at = DateTime.formatIso(now)
    yield* writeAtomic(scratchName(home, "beat-update-checked"), file, at)
    return at
  })).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(platformFailure("claim " + file)(error))))
  return Option.getOrNull(claim)
})

interface UpdateTarget {
  readonly machine: string
  readonly command: Command
}

const dispatchTargets = (self: Command, machines: ReadonlyArray<Machine>): ReadonlyArray<UpdateTarget> => {
  const local = machines.find((machine) => ownedBySweep(machine) && throughFor(machine) === null)
  return [
    { machine: local?.name ?? "a dispatch machine", command: self },
    ...machines.flatMap((machine) => {
      const command = throughFor(machine)
      return command === null ? [] : [{ machine: machine.name, command }]
    })
  ]
}

const decodeUpdate = Schema.decodeEffect(UpdateJson)

const readUpdate = ({ machine, command }: UpdateTarget) => {
  const action = (result: UpdateAction["result"]): UpdateAction => ({ kind: "update", machine, result })
  const unread = (detail: string, retryable: boolean): UpdateAction => action({ outcome: "unread", detail, retryable })
  return capture([...command, "update", "--json"], null).pipe(
    Effect.flatMap(({ exitCode, stdout, stderr }) => decodeUpdate(stdout.trim()).pipe(
      Effect.map(action),
      Effect.catchTag("SchemaError", () => Effect.succeed(exitCode === 0
        ? unread("the update command did not print an orc.update.v1 document", false)
        : unread("the update command exited " + String(exitCode) + ": " + (stderr.trim() || stdout.trim()), true)))
    )),
    Effect.catchTag("RunnerError", (error) => Effect.succeed(unread(error.detail, true))),
    Effect.timeoutOrElse({ duration: "5 minutes", orElse: () => Effect.succeed(unread("the update command did not answer within 5 minutes", true)) })
  )
}

export const runBeatUpdates = Effect.fnUntraced(function*(root: string, home: string, beat: string, machines: ReadonlyArray<Machine>, self: Command) {
  const at = yield* claimHour(home)
  if (at === null) {
    return []
  }
  return yield* Effect.forEach(dispatchTargets(self, machines), (target, index) => Effect.gen(function*() {
    const action = yield* readUpdate(target)
    if (action.result.outcome === "installed") {
      yield* recordEvent(root, { key: beat + ".update." + index, at, text: updateLine(action) })
    }
    yield* routeUpdateResult(root, action, at)
    return action
  }), { concurrency: "unbounded" })
})
