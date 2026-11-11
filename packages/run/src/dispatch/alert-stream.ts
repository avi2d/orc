import { Effect } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { alertsFile } from "./events"
import { PueueState, taskLabel } from "./pueue-status"
import { type Command, pueueDone, type RunnerError } from "./runner"
import { ensureGroup } from "./runner-exec"
import { decodeJson, pueue } from "./runner-exec"

export const liveAlertStream = (): Command | null => {
  const dash = Bun.which("orc-dash")
  return dash === null ? null : [dash, "alerts", "--json"]
}

const appendScript = "out=$1; shift; exec \"$@\" >> \"$out\""

// The group runs one task at a time, so of two runners that queue a stream at once the second only waits behind the first.
export const ensureAlertStream = (home: string, stream: Command): Effect.Effect<string | null, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const label = taskLabel(home, "alerts")
    const group = "orc-alerts-" + new Bun.CryptoHasher("sha256").update(label).digest("hex").slice(0, 12)
    yield* ensureGroup(group, ["--parallel", "1"])
    const state = yield* pueue(["status", "--json"]).pipe(Effect.flatMap((text) => decodeJson(text, PueueState, "pueue status --json")))
    if (Object.values(state.tasks).some((task) => task.group === group && task.label === label && !pueueDone(task))) {
      return null
    }
    const output = alertsFile(home + "/backlog")
    const id = yield* pueue(["add", "--group", group, "--label", label, "--working-directory", home, "--print-task-id", "--escape", "--", "sh", "-c", appendScript, "orc-alerts", output, ...stream])
    return "queued the alert stream as pueue task " + id.trim() + " in group " + group + ", its fires to " + output
  })
