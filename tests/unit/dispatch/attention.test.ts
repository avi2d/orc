import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { parseDispatchArgs } from "../../../packages/run/src/dispatch/args"
import { type Asked, closeItem, isOverdue, openItem, openItems } from "../../../packages/run/src/dispatch/attention"
import { attentionJson, formatAttention } from "../../../packages/run/src/dispatch/attention-view"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const asked = (at: string, task = "orc-1"): Asked => ({ kind: "review-question", task, text: "Keep the old flag?", asked: at, owner: "user" })

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
      const shown = await run(openItems(root))
      formatAttention(shown, "2026-11-02T10:30:00.000Z")
      attentionJson(shown, "2026-11-02T10:30:00.000Z")
      expect((await run(openItems(root))).map((entry) => entry.id)).toEqual(["orc-1.r2.a"])
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
