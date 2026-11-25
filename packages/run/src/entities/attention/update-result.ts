import { Effect } from "effect"
import { installerError } from "../orc-update/index"
import { openItems, openOrRefreshItem, withdrawItem } from "./attention"
import type { UpdateAction } from "./beat-action"

const orcOn = (machine: string): string => "orc on " + machine

export const updateLine = ({ machine, result }: UpdateAction): string => {
  const orc = orcOn(machine)
  switch (result.outcome) {
    case "installed": {
      return orc + " moved from " + result.running + " to " + result.found
    }
    case "current": {
      return orc + " is current at " + result.running
    }
    case "failed": {
      return orc + " could not update: " + installerError(result)
    }
    case "unread": {
      return orc + " could not update: " + result.detail
    }
  }
}

const machineKey = (machine: string): string => new Bun.CryptoHasher("sha256").update(machine).digest("hex")

export const routeUpdateResult = Effect.fnUntraced(function*(root: string, action: UpdateAction, at: string) {
  const { machine, result } = action
  const prefix = "update-failed." + machineKey(machine) + "."
  const failed = result.outcome === "failed" || result.outcome === "unread"
  const target = result.outcome === "unread" ? "unread" : result.found ?? "registry"
  const id = failed ? prefix + machineKey(target) : null
  const reason = id === null ? "the update check succeeded" : "the failed update target changed"
  for (const item of yield* openItems(root, (name) => name.startsWith(prefix))) {
    if (item.id !== id) {
      yield* withdrawItem(root, item.id, reason, at)
    }
  }
  if (id !== null && failed) {
    yield* openOrRefreshItem(root, id, {
      kind: "update-failed",
      task: machine,
      subject: "the orc update on " + machine,
      text: updateLine(action),
      asked: at,
      owner: result.retryable === false ? "user" : "decider"
    })
  }
})
