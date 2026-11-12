import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { parseDispatchArgs } from "../../../packages/run/src/dispatch/args"
import { addTask, claimTask, closeStartedTask, listTasks, markPosted, writeTaken } from "../../../packages/run/src/entities/backlog/index"
import { markEventPosted, recordEvent, unpostedEvents } from "../../../packages/run/src/entities/events/index"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const spec = { title: "Fix the thing", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], created: "2026-10-27T10:00:00.000Z", body: "# Fix the thing\n" }

const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-10-27T10:01:00.000Z" }

describe("marking a close posted", () => {
  test("concurrent marks all resolve leaving one posted record, and a late mark is a no-op", async () => {
    const root = await mkdtemp(join(tmpdir(), "orc-posted-"))
    try {
      const record = await run(addTask(root, spec))
      await run(claimTask(root, record.spec.id))
      await run(writeTaken(root, { spec: record.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-10-27T10:02:00.000Z", log: root + "/logs/orc-1.log" } } }))
      await run(closeStartedTask(root, record.spec.id, "done", "", { pr: null, report: null }, "2026-10-27T11:00:00.000Z"))
      const marks = await run(Effect.all(Array.from({ length: 8 }, () => markPosted(root, "orc-1", "2026-10-27T11:01:00.000Z")), { concurrency: "unbounded" }))
      expect(marks).toHaveLength(8)
      expect((await run(listTasks(root))).map((task) => task.state.kind === "closed" ? task.state.postedAt : null)).toEqual(["2026-10-27T11:01:00.000Z"])
      expect(await readdir(join(root, "closed"))).toEqual(["orc-1.md"])
      expect(await run(markPosted(root, "orc-1", "2026-10-27T11:02:00.000Z"))).toBe(false)
      expect((await run(listTasks(root))).map((task) => task.state.kind === "closed" ? task.state.postedAt : null)).toEqual(["2026-10-27T11:01:00.000Z"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a dotted project's id acme.io-1 is a task id, not the event key acme.io-1", async () => {
    expect(parseDispatchArgs("backlog", ["posted", "acme.io-1"])).toEqual({ kind: "MarkPosted", id: "acme.io-1" })
    expect(parseDispatchArgs("backlog", ["posted", "acme.io-1.merged"])).toEqual({ kind: "MarkEventPosted", key: "acme.io-1.merged" })
    const root = await mkdtemp(join(tmpdir(), "orc-posted-"))
    try {
      const record = await run(addTask(root, { ...spec, project: "acme.io" }))
      expect(record.spec.id).toBe("acme.io-1")
      await run(claimTask(root, record.spec.id))
      await run(writeTaken(root, { spec: record.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-10-27T10:02:00.000Z", log: root + "/logs/acme.io-1.log" } } }))
      await run(closeStartedTask(root, record.spec.id, "done", "", { pr: null, report: null }, "2026-10-27T11:00:00.000Z"))
      expect(await run(markPosted(root, "acme.io-1", "2026-10-27T11:01:00.000Z"))).toBe(true)
      expect((await run(listTasks(root))).map((task) => task.state.kind === "closed" ? task.state.postedAt : null)).toEqual(["2026-10-27T11:01:00.000Z"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("an uppercase-and-underscore project's merged event My_App-1.merged is posted instead of dropped", async () => {
    const root = await mkdtemp(join(tmpdir(), "orc-posted-"))
    try {
      const record = await run(addTask(root, { ...spec, project: "My_App" }))
      expect(record.spec.id).toBe("My_App-1")
      const key = record.spec.id + ".merged"
      await run(recordEvent(root, { key, at: "2026-10-27T11:00:00.000Z", text: "My_App-1 Fix the thing merged" }))
      expect((await run(unpostedEvents(root))).map((event) => event.key)).toEqual([key])
      expect(parseDispatchArgs("backlog", ["posted", key])).toEqual({ kind: "MarkEventPosted", key })
      expect(await run(markEventPosted(root, key))).toBe(true)
      expect(await run(unpostedEvents(root))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
