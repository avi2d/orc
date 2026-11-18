import { Effect, type FileSystem } from "effect"
import type { BacklogError } from "../backlog/index"
import { checkRefusals, greenChecks, type PullRequestView, redChecks } from "../pull-request/index"
import type { AttentionItem, Asked } from "./attention-item"
import { closeItem, itemId, openItem, openItems, readItem, withdrawItem, writeItem } from "./attention"

const openOrReopenPrItem = (root: string, id: string, asked: Asked): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const item = yield* readItem(root, id)
    if (item === null) {
      yield* Effect.asVoid(openItem(root, id, asked))
    } else if (item.state.kind === "withdrawn") {
      yield* writeItem(root, id, { ...asked, state: { kind: "open" } })
    } else if (item.state.kind === "open" && item.text !== asked.text) {
      yield* writeItem(root, id, { ...asked, asked: item.asked, state: { kind: "open" } })
    }
  })

// Each head commit gets its own items, so a fix pushed after a red check opens anew.
export const routePullRequest = (
  root: string,
  task: string,
  pr: string,
  view: PullRequestView,
  at: string,
  waits: ReadonlyArray<string>
): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const ended = view.state === "MERGED" ? "merged" : view.state === "CLOSED" ? "closed without merging" : null
    const refusals = checkRefusals(view)
    const red = redChecks(view)
    const holds = (kind: AttentionItem["kind"]): boolean => ended === null && (kind === "check-red" ? refusals.length > 0 : red.length === 0)
    const prefixes = [itemId(task, "check-red") + ".", itemId(task, "pr-ready") + "."]
    const settled = (yield* openItems(root, (name) => prefixes.some((prefix) => name.startsWith(prefix)))).filter((entry) =>
      !(entry.id === itemId(task, entry.item.kind, view.headRefOid) && holds(entry.item.kind))
    )
    yield* Effect.forEach(settled, (entry) =>
      entry.item.kind === "pr-ready" && ended !== null
        ? Effect.asVoid(closeItem(root, entry.id, { words: ended, at }))
        : Effect.asVoid(withdrawItem(root, entry.id, ended === null ? "head or checks changed" : "PR " + ended, at)), { discard: true })
    if (ended !== null) {
      return
    }
    if (red.length > 0) {
      yield* openOrReopenPrItem(root, itemId(task, "check-red", view.headRefOid), { kind: "check-red", task, text: pr + ": the check " + red.join(", ") + " is red", asked: at, owner: "user" })
    } else if (refusals.length === 0) {
      yield* openOrReopenPrItem(root, itemId(task, "pr-ready", view.headRefOid), { kind: "pr-ready", task, text: pr + " is ready to merge, checks green: " + greenChecks(view).join(", ") + waits.map((wait) => "; it " + wait).join(""), asked: at, owner: "user" })
    }
  })
