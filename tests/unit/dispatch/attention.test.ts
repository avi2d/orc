import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Array as Arr, Effect } from "effect"
import { parseDispatchArgs } from "../../../packages/run/src/dispatch/args"
import { type Asked, closeItem, isOverdue, openItem, openItems, routeReviewQuestions } from "../../../packages/run/src/dispatch/attention"
import { attentionJson, attentionText } from "../../../packages/run/src/dispatch/attention-view"
import type { ParkedQuestion, TaskRecord } from "../../../packages/run/src/dispatch/task-record"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const asked = (at: string, task = "orc-1"): Asked => ({ kind: "review-question", task, text: "Keep the old flag?", asked: at, owner: "user" })

const question = (id: string, text: string, askedAt: string, answer: { words: string; at: string } | null): ParkedQuestion => ({
  id,
  text,
  asked: askedAt,
  answer: answer === null ? null : { ...answer, relayedTo: null }
})

const parkedTask = (id: string, first: ParkedQuestion, rest: ReadonlyArray<ParkedQuestion>, state: TaskRecord["state"]): TaskRecord => ({
  spec: { id, title: id, project: "orc", kind: "ship", internal: false, machine: null, dependsOn: [], created: "2026-11-02T10:00:00.000Z", body: id },
  hold: null,
  parked: { branch: "orc/" + id, questions: Arr.make(first, ...rest) },
  state
})

const closedTask = (id: string): TaskRecord => ({
  spec: { id, title: id, project: "orc", kind: "ship", internal: false, machine: null, dependsOn: [], created: "2026-11-02T10:00:00.000Z", body: id },
  hold: null,
  parked: null,
  state: {
    kind: "closed",
    claim: { beat: "beat-1", machine: "linux", account: "acme", takenAt: "2026-11-02T10:30:00.000Z" },
    closing: { outcome: "stopped", started: { at: "2026-11-02T10:05:00.000Z", log: "orc-1.log" }, reason: "the captain stopped orc-1", pr: null, report: null },
    closedAt: "2026-11-02T10:40:00.000Z",
    postedAt: null
  }
})

const withRoot = async (use: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-attention-"))
  try {
    await use(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("the attention queue", () => {
  test("an open item is one file with kind, task, text, time asked, owner and state, not a line in a shared file", async () => {
    await withRoot(async (root) => {
      expect(await run(openItem(root, "orc-1.r2.a", asked("2026-11-02T10:20:00.000Z")))).toBe(true)
      expect(await readdir(join(root, "attention"))).toEqual(["orc-1.r2.a.json"])
      expect(JSON.parse(await readFile(join(root, "attention", "orc-1.r2.a.json"), "utf8"))).toEqual({
        kind: "review-question", task: "orc-1", text: "Keep the old flag?", asked: "2026-11-02T10:20:00.000Z", owner: "user", state: { kind: "open" }
      })
    })
  })

  test("open items list oldest first instead of in the order they were written", async () => {
    await withRoot(async (root) => {
      await run(openItem(root, "b-newer", asked("2026-11-02T10:30:00.000Z", "orc-2")))
      await run(openItem(root, "a-older", asked("2026-11-02T10:20:00.000Z", "orc-1")))
      await run(openItem(root, "c-oldest", asked("2026-11-02T09:00:00.000Z", "orc-3")))
      expect((await run(openItems(root))).map((entry) => entry.item.task)).toEqual(["orc-3", "orc-1", "orc-2"])
    })
  })

  test("showing an item twice leaves it open instead of handling it", async () => {
    await withRoot(async (root) => {
      await run(openItem(root, "orc-1.r2.a", asked("2026-11-02T10:20:00.000Z")))
      await run(attentionText(false, root))
      await run(attentionText(true, root))
      expect((await run(openItems(root))).map((entry) => entry.id)).toEqual(["orc-1.r2.a"])
    })
  })

  test("a question asked before asked_at existed opens its item at the beat time instead of an unreadable age", async () => {
    await withRoot(async (root) => {
      await run(routeReviewQuestions(root, [parkedTask("orc-1", question("r2", "Keep the old flag?", "", null), [], { kind: "new" })], "2026-11-02T10:20:00.000Z"))
      const items = await run(openItems(root))
      expect(items.map((entry) => entry.item.asked)).toEqual(["2026-11-02T10:20:00.000Z"])
      expect(attentionJson(items, "2026-11-02T10:30:00.000Z").items[0]).toMatchObject({ ageSeconds: 600, overdue: true })
    })
  })

  test("closing a task withdraws its open item instead of leaving it overdue", async () => {
    await withRoot(async (root) => {
      await run(routeReviewQuestions(root, [parkedTask("orc-1", question("r2", "Keep the old flag?", "2026-11-02T10:20:00.000Z", null), [], { kind: "new" })], "2026-11-02T10:20:00.000Z"))
      expect((await run(openItems(root))).map((entry) => entry.id)).toEqual(["orc-1.r2.2026-11-02T10_20_00_000Z"])
      await run(routeReviewQuestions(root, [closedTask("orc-1")], "2026-11-02T10:40:00.000Z"))
      expect(await run(openItems(root))).toEqual([])
      expect(JSON.parse(await readFile(join(root, "attention", "orc-1.r2.2026-11-02T10_20_00_000Z.json"), "utf8"))).toMatchObject({
        state: { kind: "withdrawn", reason: "task closed", at: "2026-11-02T10:40:00.000Z" }
      })
    })
  })

  test("asking a question again withdraws the old item and opens the new asking instead of keeping both", async () => {
    await withRoot(async (root) => {
      await run(routeReviewQuestions(root, [parkedTask("orc-1", question("r2", "Keep the old flag?", "2026-11-02T10:20:00.000Z", null), [], { kind: "new" })], "2026-11-02T10:20:00.000Z"))
      await run(routeReviewQuestions(root, [parkedTask("orc-1", question("r2", "Drop the flag?", "2026-11-02T11:20:00.000Z", null), [], { kind: "new" })], "2026-11-02T11:20:00.000Z"))
      expect((await run(openItems(root))).map((entry) => entry.item.text)).toEqual(["Drop the flag?"])
      expect(JSON.parse(await readFile(join(root, "attention", "orc-1.r2.2026-11-02T10_20_00_000Z.json"), "utf8"))).toMatchObject({
        state: { kind: "withdrawn", reason: "question no longer asked" }
      })
    })
  })

  test("an answer still closes its live question instead of withdrawing it", async () => {
    await withRoot(async (root) => {
      await run(routeReviewQuestions(root, [parkedTask("orc-1", question("r2", "Keep the old flag?", "2026-11-02T10:20:00.000Z", null), [], { kind: "new" })], "2026-11-02T10:20:00.000Z"))
      await run(routeReviewQuestions(root, [parkedTask("orc-1", question("r2", "Keep the old flag?", "2026-11-02T10:20:00.000Z", { words: "Keep it", at: "2026-11-02T10:25:00.000Z" }), [], { kind: "new" })], "2026-11-02T10:25:00.000Z"))
      expect(await run(openItems(root))).toEqual([])
      expect(JSON.parse(await readFile(join(root, "attention", "orc-1.r2.2026-11-02T10_20_00_000Z.json"), "utf8"))).toMatchObject({
        state: { kind: "closed", answer: { words: "Keep it", at: "2026-11-02T10:25:00.000Z" } }
      })
    })
  })

  test("an answer closes the item and keeps its words, instead of deleting the file", async () => {
    await withRoot(async (root) => {
      await run(openItem(root, "orc-1.r2.a", asked("2026-11-02T10:20:00.000Z")))
      expect(await run(closeItem(root, "orc-1.r2.a", { words: "Keep it", at: "2026-11-02T10:25:00.000Z" }))).toBe("closed")
      expect(await run(openItems(root))).toEqual([])
      expect(JSON.parse(await readFile(join(root, "attention", "orc-1.r2.a.json"), "utf8"))).toMatchObject({ state: { kind: "closed", answer: { words: "Keep it", at: "2026-11-02T10:25:00.000Z" } } })
      expect(await run(closeItem(root, "orc-1.r2.a", { words: "Drop it", at: "2026-11-02T10:26:00.000Z" }))).toBe("already closed")
    })
  })

  test("opening the same item again keeps it as first asked instead of reopening a closed one", async () => {
    await withRoot(async (root) => {
      await run(openItem(root, "orc-1.r2.a", asked("2026-11-02T10:20:00.000Z")))
      await run(closeItem(root, "orc-1.r2.a", { words: "Keep it", at: "2026-11-02T10:25:00.000Z" }))
      expect(await run(openItem(root, "orc-1.r2.a", asked("2026-11-02T10:20:00.000Z")))).toBe(false)
      expect(await run(openItems(root))).toEqual([])
    })
  })

  test("an open item is overdue only after 5 minutes, not at 4 minutes 59 seconds", () => {
    const item = { ...asked("2026-11-02T10:00:00.000Z"), state: { kind: "open" as const } }
    expect(isOverdue(item, Date.parse("2026-11-02T10:04:59.000Z"))).toBe(false)
    expect(isOverdue(item, Date.parse("2026-11-02T10:05:01.000Z"))).toBe(true)
  })

  test("the json gives each open item its age and overdue flag instead of only the time asked", async () => {
    await withRoot(async (root) => {
      await run(openItem(root, "late", asked("2026-11-02T10:00:00.000Z", "orc-1")))
      await run(openItem(root, "fresh", asked("2026-11-02T10:08:00.000Z", "orc-2")))
      expect(attentionJson(await run(openItems(root)), "2026-11-02T10:10:00.000Z")).toEqual({
        schema: "orc.attention.v1",
        at: "2026-11-02T10:10:00.000Z",
        items: [
          { id: "late", kind: "review-question", task: "orc-1", text: "Keep the old flag?", asked: "2026-11-02T10:00:00.000Z", owner: "user", ageSeconds: 600, overdue: true },
          { id: "fresh", kind: "review-question", task: "orc-2", text: "Keep the old flag?", asked: "2026-11-02T10:08:00.000Z", owner: "user", ageSeconds: 120, overdue: false }
        ]
      })
    })
  })

  test("orc attention takes only --json, refusing other words", () => {
    expect(parseDispatchArgs("attention", [])).toEqual({ kind: "ShowAttention", json: false })
    expect(parseDispatchArgs("attention", ["--json"])).toEqual({ kind: "ShowAttention", json: true })
    expect(parseDispatchArgs("attention", ["--all"])).toEqual({ kind: "UsageError", detail: "unexpected argument: --all" })
  })
})
