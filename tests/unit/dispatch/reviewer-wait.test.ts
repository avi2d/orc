import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { ensureBacklog, listTasks, parseTaskFile, renderTaskFile, type TaskRecord } from "../../../packages/run/src/entities/backlog/index"
import { readRequest } from "../../../packages/run/src/features/queueing-a-task/runner-request"
import { insertRun, openDatabase } from "../../../packages/run/src/entities/run-history/index"
import { closeFinished } from "../../../packages/run/src/widgets/beat/beat-close"
import { backlogJson } from "../../../packages/run/src/widgets/beat/board"
import { guardJson } from "../../../packages/herdr-app/src/guard"
import { infoRows } from "../../../packages/herdr-app/src/task"
import { taskDetails } from "../../../packages/herdr-app/src/task-guard"
import { beatWith, claim, config, macProjects, pueueDone, run, spec, startTaskOne, withBacklog } from "../../lib/dispatch-beat"

const wait = {
  reason: "no reviewer in the chain has quota room: beta/reviewer: beta-main 2% left, floor 15%",
  reviewers: [{ provider: "beta", model: "beta/reviewer", credential: { kind: "only-account" } }]
} as const
const parkedReason = "The review turn waits for a reviewer in the chain to have room, so the run parks and no PR opens: " + wait.reason

const accounts = [{ name: "main", kind: "none" }, { name: "beta-main", provider: "beta", kind: "none", models: { implementer: "beta/coder", fixer: "beta/coder" } }] as const

const quotaAt = (root: string, betaPercent: number, mainPercent = 80) => {
  const reply = JSON.stringify({ schema: "orc.quota.v1", accounts: [{ name: "main", remainingPercent: mainPercent }, { name: "beta-main", remainingPercent: betaPercent }] })
  return writeFile(join(root, "dispatch.json"), JSON.stringify({
    machines: [{ name: "mac", slots: 1, start: ["true"] }],
    quota: { provider: "keyed", command: ["sh", "-c", "printf '%s' '" + reply + "'"], accounts, floorPercent: 15 }
  }))
}

const current = async (root: string): Promise<TaskRecord> => {
  const task = (await run(listTasks(root))).at(0)
  if (task === undefined) throw new Error("the backlog holds no task")
  return task
}

const parkedForReviewer = async (root: string): Promise<void> => {
  await startTaskOne(root, ["orc", "runner", "start"], null)
  await writeFile(join(root, "projects.json"), JSON.stringify({ projects: macProjects }))
  await run(Effect.acquireUseRelease(
    openDatabase(root),
    (db) => Effect.sync(() => insertRun(db, { id: "run-1", project: "/checkout", branch: "orc/orc-1", taskFile: "orc-1.md", status: "failed", started: "2026-10-27T10:02:00.000Z", endReason: parkedReason })),
    (db) => Effect.sync(() => db.close())
  ))
  await mkdir(join(root, "runs", "run-1"), { recursive: true })
  await writeFile(join(root, "runs", "run-1", "reviewer-wait.json"), JSON.stringify(wait))
  const progress = await Effect.runPromise(closeFinished({ root, home: root, config: { ...config, machines: [{ name: "mac", slots: 1, start: ["orc", "runner", "start"] }] } }, await current(root))
    .pipe(Effect.provide(Layer.merge(BunServices.layer, pueueDone(root, { Failed: 1 })))))
  expect(progress).toEqual({ kind: "ended", action: { kind: "reviewer-wait", task: "orc-1", machine: "mac", run: "run-1", reason: parkedReason } })
}

describe("a run that waits for a reviewer with room", () => {
  test('a resumed task does not fail parsing or backlog listing with "a parked task names no question"', async () => {
    await withBacklog(async (root) => {
      await run(ensureBacklog(root))
      const resumed: TaskRecord = {
        spec: { ...spec, id: "orc-1" },
        hold: null,
        parked: { branch: "orc/orc-1", questions: [], origin: { machine: "mac", run: "run-1" }, at: "2026-10-27T10:05:00.000Z" },
        state: { kind: "started", claim, started: { at: "2026-10-27T10:06:00.000Z", log: join(root, "logs", "orc-1.log") } }
      }
      const file = join(root, "taken", "orc-1.md")
      const text = renderTaskFile(resumed)
      expect(await run(parseTaskFile(file, "taken", text))).toEqual(resumed)
      await writeFile(file, text)
      expect(await run(listTasks(root))).toEqual([resumed])
    })
  })

  test("parks its task with the wait and its run instead of closing it failed or spending its retry", async () => {
    await withBacklog(async (root) => {
      await parkedForReviewer(root)
      const parked = await current(root)
      expect(parked.state.kind).toBe("new")
      expect(parked.retry).toBeUndefined()
      expect(parked.parked).toMatchObject({ branch: "orc/orc-1", origin: { machine: "mac", run: "run-1" }, questions: [], reviewerWait: wait })
    })
  })

  test("the task detail's Waits for reviewer row reads the wait's reason, instead of a dash that hides why the task does not start", async () => {
    await withBacklog(async (root) => {
      await parkedForReviewer(root)
      const view = { tasks: [await current(root)], events: [], projects: { kind: "read", projects: macProjects }, room: { kind: "read", room: [] }, merged: new Set<string>(), prStates: new Map(), beatWaits: null, deciderOwns: () => false } as const
      const read = guardJson(JSON.stringify(backlogJson(view)), taskDetails)
      if (read.kind !== "ok") throw new Error(read.reason)
      const detail = read.value.at(0)
      if (detail === undefined) throw new Error("the backlog JSON holds no task")
      expect(infoRows(detail, []).find((row) => row.label === "Waits for reviewer")?.value).toBe(wait.reason)
    })
  })

  test("the beat keeps it parked while no reviewer has room, instead of resuming into the same wait", async () => {
    await withBacklog(async (root) => {
      await parkedForReviewer(root)
      await quotaAt(root, 2)
      const report = await beatWith(root, pueueDone(root, { Failed: 1 }))
      expect(report.actions).toContainEqual({ kind: "waits", task: "orc-1", reason: "parked until a reviewer in the chain has room: beta/reviewer: beta-main 2% left, floor 15%" })
      expect((await current(root)).state.kind).toBe("new")
    })
  })

  test("the beat resumes the parked run once a reviewer has room, instead of starting a new run", async () => {
    await withBacklog(async (root) => {
      await parkedForReviewer(root)
      await quotaAt(root, 80)
      await beatWith(root, pueueDone(root, { Failed: 1 }))
      const resumed = await current(root)
      expect(resumed.state.kind).toBe("started")
      expect(resumed.parked?.reviewerWait).toBeUndefined()
      const request = await run(readRequest({ ORC_TASK_ID: "orc-1", ORC_TASK_FILE: join(root, "taken", "orc-1.md"), ORC_TASK_CHECKOUT: "/checkout", ORC_TASK_PROVIDER: "keyed" }, Effect.succeed("")))
      expect(request.resumeRun).toBe("run-1")
    })
  })

  test("the beat resumes the parked run on the waiting entry's account once the implementer's account runs out, instead of waiting on the provider that wrote the code", async () => {
    await withBacklog(async (root) => {
      await parkedForReviewer(root)
      await quotaAt(root, 80, 2)
      await beatWith(root, pueueDone(root, { Failed: 1 }))
      const resumed = await current(root)
      if (resumed.state.kind !== "started") throw new Error("the beat did not resume the task: " + resumed.state.kind)
      expect(resumed.state.claim.account).toBe("beta-main")
      expect(resumed.parked?.reviewerWait).toBeUndefined()
    })
  })
})
