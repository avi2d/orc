import { Effect, FileSystem } from "effect"
import { platformFailure, readIfPresent, scratchName, writeAtomic } from "../backlog/index"
import { installerError } from "../orc-update/index"
import { openItems, openOrRefreshItem, withdrawItem } from "./attention"
import { attentionFolder } from "./attention-store"
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

const digest = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex")

const withdrawOthers = Effect.fnUntraced(function*(root: string, prefix: string, keep: string | null, reason: string, at: string) {
  for (const item of yield* openItems(root, (name) => name.startsWith(prefix))) {
    if (item.id !== keep) {
      yield* withdrawItem(root, item.id, reason, at)
    }
  }
})

// A successful check ends the failure that started at this time, so a later failure opens a new item even after an answer closed the old one.
const failingSince = Effect.fnUntraced(function*(root: string, prefix: string, at: string) {
  const folder = attentionFolder(root)
  const file = folder + "/." + prefix + "since"
  const since = yield* readIfPresent(file)
  if (since !== null) {
    return since
  }
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(folder, { recursive: true }).pipe(Effect.mapError(platformFailure("make " + folder)))
  yield* writeAtomic(scratchName(folder, prefix + "since"), file, at)
  return at
})

const endFailure = Effect.fnUntraced(function*(root: string, prefix: string) {
  const fs = yield* FileSystem.FileSystem
  const file = attentionFolder(root) + "/." + prefix + "since"
  yield* fs.remove(file, { force: true }).pipe(Effect.mapError(platformFailure("remove " + file)))
})

export const routeUpdateResult = Effect.fnUntraced(function*(root: string, action: UpdateAction, at: string) {
  const { machine, result } = action
  const prefix = "update-failed." + digest(machine) + "."
  if (result.outcome === "installed" || result.outcome === "current") {
    yield* withdrawOthers(root, prefix, null, "the update check succeeded", at)
    yield* endFailure(root, prefix)
    return
  }
  const since = yield* failingSince(root, prefix, at)
  const target = result.outcome === "unread" ? "unread" : result.found ?? "registry"
  const id = prefix + digest(since + "\n" + target)
  yield* withdrawOthers(root, prefix, id, "the failed update target changed", at)
  yield* openOrRefreshItem(root, id, {
    kind: "update-failed",
    task: machine,
    subject: "the orc update on " + machine,
    text: updateLine(action),
    asked: at,
    owner: result.retryable === false ? "user" : "decider"
  })
})
