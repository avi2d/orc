import { Effect, type FileSystem } from "effect"
import type { BacklogError } from "../backlog/index"
import { checkRefusals, greenChecks, type PullRequestView, redChecks } from "../pull-request/index"
import type { Asked, AttentionItem } from "./attention-item"
import type { BeatAction } from "./beat-action"
import { choice, closeItem, itemId, openItem, openItems, readItem, withdrawItem, writeItem } from "./attention"

const unreachedPrefix = (task: string): string => itemId(task, "machine-unreached") + "."

// An item opens once per id, so the id carries the stretch's start for a machine lost again after it answered.
export const openUnreachedMachine = (root: string, task: string, machine: string, since: string, reason: string, at: string): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.asVoid(openItem(root, itemId(task, "machine-unreached", since), {
    kind: "machine-unreached",
    task,
    text: "orc has not reached " + machine + " since " + since + ", so it cannot tell whether the run of " + task + " still works there, and the task stays started: " + reason,
    ...choice(
      "the run of " + task + " on " + machine,
      { text: "wait", outcome: "the task stays started, and each beat reads its run again" },
      { text: "close", outcome: "orc backlog close " + task + " failed closes the task failed and frees its slot on " + machine }
    ),
    asked: at,
    owner: "user"
  }))

export const withdrawUnreachedMachine = (root: string, task: string, at: string): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const open = yield* openItems(root, (name) => name.startsWith(unreachedPrefix(task)))
    yield* Effect.forEach(open, (entry) => Effect.asVoid(withdrawItem(root, entry.id, "the machine answered again", at)), { discard: true })
  })

export const openRunDeaths = (root: string, actions: ReadonlyArray<BeatAction>, at: string): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
  Effect.forEach(actions, (action) =>
    (action.kind === "closed" && action.outcome === "failed") || action.kind === "start-failed"
      ? Effect.asVoid(openItem(root, itemId(action.task, "run-died"), {
        kind: "run-died",
        task: action.task,
        text: "the run on " + action.machine + " died: " + action.reason,
        ...choice(
          "the run of " + action.task + " on " + action.machine,
          { text: "rerun", outcome: "orc backlog add <project> <task-file> adds the task again under a new id, and the next beat starts it" },
          { text: "close", outcome: "the task stays closed failed, and no run starts" }
        ),
        asked: at,
        owner: "user"
      }))
      : Effect.void, { discard: true })

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

export const pullRequestHeld = (root: string, task: string, head: string): Effect.Effect<boolean, BacklogError, FileSystem.FileSystem> =>
  Effect.map(readItem(root, itemId(task, "pr-ready", head)), (item) => item?.state.kind === "closed" && item.state.answer.words.trim().toLowerCase().startsWith("hold"))

// Each head commit gets its own items, so a fix pushed after a red check opens anew.
export const routePullRequest = (root: string, task: string, pr: string, view: PullRequestView, at: string, waits: ReadonlyArray<string> = []): Effect.Effect<void, BacklogError, FileSystem.FileSystem> =>
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
      yield* openOrReopenPrItem(root, itemId(task, "check-red", view.headRefOid), {
        kind: "check-red",
        task,
        text: pr + ": the check " + red.join(", ") + " is red",
        ...choice(
          "the PR " + pr + " of " + task,
          { text: "send back", outcome: "orc backlog send-back " + task + " <words> sends the PR back for another pass on the red check" },
          { text: "close", outcome: "the PR stays open with the red check, and nothing merges" }
        ),
        asked: at,
        owner: "user"
      })
    } else if (refusals.length === 0) {
      yield* openOrReopenPrItem(root, itemId(task, "pr-ready", view.headRefOid), {
        kind: "pr-ready",
        task,
        text: pr + " is ready to merge, checks green: " + greenChecks(view).join(", ") + waits.map((wait) => "; it " + wait).join(""),
        ...choice(
          "the PR " + pr + " of " + task,
          { text: "merge", outcome: "orc merge " + task + " merges the PR into main, and the item closes with the answer merged" },
          { text: "hold", outcome: "the PR stays open and unmerged, and the item closes" }
        ),
        asked: at,
        owner: "user"
      })
    }
  })
