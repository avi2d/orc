import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { claimTask, closeStartedTask, listTasks, writeTaken } from "../../../packages/run/src/entities/backlog/index"
import { openRunDeaths } from "../../../packages/run/src/entities/attention/index"
import { openItem, openItems } from "../../../packages/run/src/entities/attention/attention"
import { retryStartedTask, sendBackClosedTask } from "../../../packages/run/src/entities/parked-runs/index"
import { readRequest } from "../../../packages/run/src/features/queueing-a-task/runner-request"
import { unpostedEvents } from "../../../packages/run/src/entities/events/index"
import { insertRun, openDatabase } from "../../../packages/run/src/entities/run-history/index"
import { closeFinished } from "../../../packages/run/src/widgets/beat/beat-close"
import { claim, config, pueueDone, run, startTaskOne, withBacklog } from "../../lib/dispatch-beat"

const sweepConfig = { ...config, machines: [{ name: "mac", slots: 1, start: ["orc", "runner", "start"] }] }

const failedRun = (root: string, id = "run-1", endReason = "orc exited 1") => run(Effect.acquireUseRelease(
  openDatabase(root),
  (db) => Effect.sync(() => insertRun(db, { id, project: "/checkout", branch: "orc/orc-1", taskFile: "orc-1.md", status: "failed", started: "2026-10-27T10:02:00.000Z", endReason })),
  (db) => Effect.sync(() => db.close())
))

describe("a failed run", () => {
  test("an owner close winning the retry race returns untracked instead of failing", async () => {
    await withBacklog(async (root) => {
      await startTaskOne(root, ["orc", "runner", "start"], null)
      await failedRun(root)
      const task = (await run(listTasks(root)))[0]
      if (task === undefined) throw new Error("missing task")
      await run(closeStartedTask(root, "orc-1", "stopped", "the owner stopped it", { pr: null, report: null }, "2026-10-27T10:05:00.000Z"))
      const progress = await Effect.runPromise(closeFinished({ root, home: root, config: sweepConfig }, task).pipe(Effect.provide(Layer.merge(BunServices.layer, pueueDone(root, { Failed: 1 })))))
      expect(progress).toEqual({ kind: "untracked" })
      expect((await run(listTasks(root)))[0]).toMatchObject({ state: { kind: "closed", closing: { outcome: "stopped" } } })
    })
  })

  test("a failed retry event write does not abort the beat or leave stale attention open", async () => {
    await withBacklog(async (root) => {
      await startTaskOne(root, ["orc", "runner", "start"], null)
      await failedRun(root)
      const task = (await run(listTasks(root)))[0]
      if (task === undefined) throw new Error("missing task")
      await run(openItem(root, "orc-1.pr-ready", { kind: "pr-ready", task: "orc-1", text: "Old merge request", asked: "2026-10-27T10:00:00.000Z", owner: "user" }))
      await writeFile(join(root, "events"), "not a directory")
      const progress = await Effect.runPromise(closeFinished({ root, home: root, config: sweepConfig }, task).pipe(Effect.provide(Layer.merge(BunServices.layer, pueueDone(root, { Failed: 1 })))))
      expect(progress).toMatchObject({ kind: "ended", action: { kind: "retry", run: "run-1" } })
      expect((await run(listTasks(root)))[0]?.state.kind).toBe("new")
      expect(await run(openItems(root))).toEqual([])
    })
  })

  test("retry carries consumed hold guidance instead of marking it fresh", async () => {
    await withBacklog(async (root) => {
      await startTaskOne(root, ["orc", "runner", "start"], null)
      const task = (await run(listTasks(root)))[0]
      if (task === undefined) throw new Error("missing task")
      await run(writeTaken(root, {
        ...task,
        parked: { branch: "orc/orc-1", questions: [], origin: { machine: "mac", run: "run-0" }, at: "2026-10-27T09:00:00.000Z" },
        hold: { reason: "the resume parked again", repeat: true, until: null, questions: [], at: "2026-10-27T09:05:00.000Z", answer: { words: "fix the lint finding first", at: "2026-10-27T10:00:00.000Z" } }
      }))
      await run(retryStartedTask(root, "orc-1", "mac", "run-1", "2026-10-27T10:05:00.000Z"))
      const retried = (await run(listTasks(root)))[0]
      expect(retried?.parked?.at).toBe("2026-10-27T10:05:00.000Z")
      await run(claimTask(root, "orc-1"))
      const request = await run(readRequest({ ORC_TASK_ID: "orc-1", ORC_TASK_FILE: join(root, "taken", "orc-1.md"), ORC_TASK_CHECKOUT: "/checkout", ORC_TASK_PROVIDER: "keyed" }, Effect.succeed("")))
      expect(request.answers).toEqual([{ question: "hold-release-carried", answer: "Current guidance: fix the lint finding first" }])
    })
  })

  test("a send-back neither reuses a spent retry nor drops its PR", async () => {
    await withBacklog(async (root) => {
      await startTaskOne(root, ["orc", "runner", "start"], null)
      await failedRun(root)
      const sweep = async () => {
        const task = (await run(listTasks(root)))[0]
        if (task === undefined) throw new Error("missing task")
        return Effect.runPromise(closeFinished({ root, home: root, config: sweepConfig }, task).pipe(Effect.provide(Layer.merge(BunServices.layer, pueueDone(root, { Failed: 1 })))))
      }
      const restart = async () => {
        await run(claimTask(root, "orc-1"))
        const task = (await run(listTasks(root)))[0]
        if (task === undefined) throw new Error("missing task")
        await run(writeTaken(root, { ...task, state: { kind: "started", claim, started: { at: "2026-10-27T10:02:00.000Z", log: join(root, "logs", "orc-1.log") } } }))
      }
      expect(await sweep()).toMatchObject({ kind: "ended", action: { kind: "retry", run: "run-1" } })
      await restart()
      await run(closeStartedTask(root, "orc-1", "done", "the PR opened", { pr: "https://github.com/acme/orc/pull/8", report: null }, "2026-10-27T10:06:00.000Z"))
      await run(sendBackClosedTask(root, "orc-1", "rename the flag", "2026-10-27T10:07:00.000Z", { machine: "mac", run: "run-1" }))
      expect((await run(listTasks(root)))[0]?.retry).toBeUndefined()
      await restart()
      await failedRun(root, "run-2")
      expect(await sweep()).toMatchObject({ kind: "ended", action: { kind: "retry", run: "run-2" } })
      expect((await run(listTasks(root)))[0]).toMatchObject({
        retry: { run: "run-2" },
        parked: { origin: { machine: "mac", run: "run-2", pr: "https://github.com/acme/orc/pull/8" } }
      })
      const events = await run(unpostedEvents(root))
      expect(events).toHaveLength(2)
      expect(events.map((event) => event.text)).toEqual(expect.arrayContaining([expect.stringContaining("run-1"), expect.stringContaining("run-2")]))
      await restart()
      expect(await sweep()).toMatchObject({ kind: "ended", action: { kind: "closed", outcome: "failed" } })
      expect((await run(listTasks(root)))[0]?.state).toMatchObject({
        kind: "closed", closing: { outcome: "failed", pr: "https://github.com/acme/orc/pull/8" }
      })
    })
  })

  test("a killed process closes instead of retrying before its run is marked stopped", async () => {
    await withBacklog(async (root) => {
      await startTaskOne(root, ["orc", "runner", "start"], null)
      await run(Effect.acquireUseRelease(
        openDatabase(root),
        (db) => Effect.sync(() => insertRun(db, { id: "run-1", project: "/checkout", branch: "orc/orc-1", taskFile: "orc-1.md", status: "running", started: "2026-10-27T10:02:00.000Z" })),
        (db) => Effect.sync(() => db.close())
      ))
      const task = (await run(listTasks(root)))[0]
      if (task === undefined) throw new Error("missing task")
      const progress = await Effect.runPromise(closeFinished({ root, home: root, config: sweepConfig }, task).pipe(Effect.provide(Layer.merge(BunServices.layer, pueueDone(root, "Killed")))))
      expect(progress).toMatchObject({ kind: "ended", action: { kind: "closed", outcome: "failed" } })
      const closed = (await run(listTasks(root)))[0]
      expect(closed?.state.kind).toBe("closed")
      expect(closed?.retry).toBeUndefined()
    })
  })

  test("a failed split closes instead of retrying its proposal", async () => {
    await withBacklog(async (root) => {
      await startTaskOne(root, ["orc", "runner", "start"], null)
      const task = (await run(listTasks(root)))[0]
      if (task === undefined) throw new Error("missing task")
      const child = { ...task, spec: { ...task.spec, parent: "orc-99" } }
      await run(writeTaken(root, child))
      await failedRun(root, "run-1", "split proposal: " + JSON.stringify({
        schema: "orc.split.v1", plan: "split", reason: "split the work", done: ["work is complete"],
        children: [{ title: "First", body: "First work", after: [] }, { title: "Second", body: "Second work", after: [] }]
      }))
      const progress = await Effect.runPromise(closeFinished({ root, home: root, config: sweepConfig }, child).pipe(Effect.provide(Layer.merge(BunServices.layer, pueueDone(root, { Failed: 1 })))))
      expect(progress).toMatchObject({ kind: "ended", action: { kind: "closed", outcome: "failed" } })
      expect((await run(listTasks(root)))[0]?.state.kind).toBe("closed")
    })
  })

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
      expect(retried?.parked?.at).toBe(retried?.retry?.at)
      expect(retried?.parked?.at).toBeDefined()
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
