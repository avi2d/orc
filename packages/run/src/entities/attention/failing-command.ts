import { Effect, type FileSystem } from "effect"
import type { BacklogError } from "../backlog/index"
import { type FailingMark, failingText, pauseAfterFailures } from "../agent/index"
import { itemId, openItem, openItems, withdrawItem } from "./attention"

export interface FailingRead {
  readonly task: string
  readonly failing: FailingMark | null
}

const failingCommandText = (mark: FailingMark): string =>
  failingText(mark) + ". The run carries on, and orc pauses it to ask continue or stop if the same command fails " + pauseAfterFailures.toString() + " times in a row."

// Only a task whose run was read this beat settles its item, so a run the beat could not reach keeps the item it had.
export const routeFailingCommands = (root: string, reads: ReadonlyArray<FailingRead>, at: string): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const live = new Set<string>()
    for (const read of reads) {
      if (read.failing !== null) {
        const id = itemId(read.task, "failing-command", read.failing.since)
        live.add(id)
        yield* openItem(root, id, { kind: "failing-command", task: read.task, text: failingCommandText(read.failing), asked: read.failing.since, owner: "user" })
      }
    }
    const readTasks = new Set(reads.map((read) => read.task))
    const stale = (yield* openItems(root)).filter((entry) => entry.item.kind === "failing-command" && readTasks.has(entry.item.task) && !live.has(entry.id))
    yield* Effect.forEach(stale, (entry) => Effect.asVoid(withdrawItem(root, entry.id, "the command stopped failing", at)), { discard: true })
  })
