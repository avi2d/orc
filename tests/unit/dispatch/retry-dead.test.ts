import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { claimTask, listTasks, writeTaken } from "../../../packages/run/src/entities/backlog/index"
import { openRunDeaths } from "../../../packages/run/src/entities/attention/index"
import { openItems } from "../../../packages/run/src/entities/attention/attention"
import { unpostedEvents } from "../../../packages/run/src/entities/events/index"
import { insertRun, openDatabase } from "../../../packages/run/src/entities/run-history/index"
import { closeFinished } from "../../../packages/run/src/widgets/beat/beat-close"
import { claim, config, pueueDone, run, startTaskOne, withBacklog } from "../../lib/dispatch-beat"

const sweepConfig = { ...config, machines: [{ name: "mac", slots: 1, start: ["orc", "runner", "start"] }] }

const failedRun = (root: string) => run(Effect.acquireUseRelease(
  openDatabase(root),
  (db) => Effect.sync(() => insertRun(db, { id: "run-1", project: "/checkout", branch: "orc/orc-1", taskFile: "orc-1.md", status: "failed", started: "2026-10-27T10:02:00.000Z", endReason: "orc exited 1" })),
  (db) => Effect.sync(() => db.close())
))

describe("a failed run", () => {
  test("a failed runner without a run ID closes instead of retrying without an origin", async () => {
    await withBacklog(async (root) => {
      await startTaskOne(root, ["orc", "runner", "start"], null)
      const task = (await run(listTasks(root)))[0]
      if (task === undefined) throw new Error("missing task")
      const progress = await Effect.runPromise(closeFinished({ root, home: root, config: sweepConfig }, task).pipe(Effect.provide(Layer.merge(BunServices.layer, pueueDone(root, { Failed: 1 })))))
      expect(progress).toMatchObject({ kind: "ended", action: { kind: "closed", outcome: "failed" } })
      expect((await run(listTasks(root)))[0]?.state.kind).toBe("closed")
    })
  })

  test("a run stopped by its owner closes instead of being retried", async () => {
    await withBacklog(async (root) => {
      await startTaskOne(root, ["orc", "runner", "start"], null)
      await run(Effect.acquireUseRelease(
        openDatabase(root),
        (db) => Effect.sync(() => insertRun(db, { id: "run-1", project: "/checkout", branch: "orc/orc-1", taskFile: "orc-1.md", status: "stopped", started: "2026-10-27T10:02:00.000Z", endReason: "the run was stopped" })),
        (db) => Effect.sync(() => db.close())
      ))
      const task = (await run(listTasks(root)))[0]
      if (task === undefined) throw new Error("missing task")
      const progress = await Effect.runPromise(closeFinished({ root, home: root, config: sweepConfig }, task).pipe(Effect.provide(Layer.merge(BunServices.layer, pueueDone(root, "Killed")))))
      expect(progress).toMatchObject({ kind: "ended", action: { kind: "closed", outcome: "stopped" } })
      expect((await run(listTasks(root)))[0]?.state.kind).toBe("closed")
    })
  })

  test("a second failure closes instead of retrying again and includes the log tail in run-died", async () => {
    await withBacklog(async (root) => {
      await startTaskOne(root, ["orc", "runner", "start"], null)
      await failedRun(root)
      await mkdir(join(root, "logs"), { recursive: true })
      await writeFile(join(root, "logs", "orc-1.log"), "last diagnostic line\n")
      const sweep = async () => {
        const task = (await run(listTasks(root)))[0]
        if (task === undefined) throw new Error("missing task")
        return Effect.runPromise(closeFinished({ root, home: root, config: sweepConfig }, task).pipe(Effect.provide(Layer.merge(BunServices.layer, pueueDone(root, { Failed: 1 })))))
      }
      const first = await sweep()
      expect(first).toMatchObject({ kind: "ended" })
      const retried = (await run(listTasks(root)))[0]
      expect(retried).toMatchObject({ state: { kind: "new" }, parked: { branch: "orc/orc-1", origin: { machine: "mac", run: "run-1" } } })
      expect((await run(unpostedEvents(root))).some((event) => event.text.includes("orc-1") && event.text.includes("retry"))).toBe(true)
      await run(claimTask(root, "orc-1"))
      const taken = (await run(listTasks(root)))[0]
      if (taken === undefined) throw new Error("missing task")
      await run(writeTaken(root, { ...taken, state: { kind: "started", claim, started: { at: "2026-10-27T10:02:00.000Z", log: join(root, "logs", "orc-1.log") } } }))
      const second = await sweep()
      expect(second).toMatchObject({ kind: "ended", action: { kind: "closed", outcome: "failed" } })
      if (second.kind !== "ended") throw new Error("missing closing action")
      await run(openRunDeaths(root, [second.action], "2026-10-27T10:06:00.000Z"))
      const items = await run(openItems(root))
      expect(items).toHaveLength(1)
      expect(items[0]?.item).toMatchObject({ kind: "run-died" })
      expect(items[0]?.item.text).toContain("last diagnostic line")
    })
  })
})
