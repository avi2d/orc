import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { parseDispatchArgs } from "../../../packages/run/src/dispatch/args"
import { addTask, claimTask, closeStartedTask, ensureBacklog, listTasks, writeTaken } from "../../../packages/run/src/dispatch/backlog"
import { holdTask } from "../../../packages/run/src/dispatch/backlog-hold"
import { answerTask } from "../../../packages/run/src/dispatch/parked"
import type { TaskRecord } from "../../../packages/run/src/dispatch/task-record"
import { renderTaskFile } from "../../../packages/run/src/dispatch/task-record-render"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const withBacklog = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-task-ids-"))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const spec = { title: "Fix the thing", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, dependsOn: [], created: "2026-10-27T10:00:00.000Z", body: "# Fix the thing\n" }

const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-10-27T10:01:00.000Z" }

const oldTask = async (root: string, id: string, project: string): Promise<void> => {
  await run(ensureBacklog(root))
  await writeFile(join(root, "ids", id), "")
  const record: TaskRecord = { spec: { ...spec, id, project }, hold: null, parked: null, state: { kind: "new" } }
  await writeFile(join(root, "new", id + ".md"), renderTaskFile(record))
}

describe("the task ids", () => {
  test("a second project's first task is website-1 instead of continuing orc's numbers as orc-3", async () => {
    await withBacklog(async (root) => {
      await run(addTask(root, spec))
      await run(addTask(root, spec))
      expect((await run(addTask(root, { ...spec, project: "website" }))).spec.id).toBe("website-1")
      expect((await run(addTask(root, spec))).spec.id).toBe("orc-3")
    })
  })
  test("the first id after old task ids is orc-5 from that project's task-4 instead of orc-1 or orc-8 from another project's task-7", async () => {
    await withBacklog(async (root) => {
      await oldTask(root, "task-4", "orc")
      await oldTask(root, "task-7", "website")
      expect((await run(addTask(root, spec))).spec.id).toBe("orc-5")
      expect((await run(addTask(root, { ...spec, project: "website" }))).spec.id).toBe("website-8")
    })
  })
  test("a project named orc-tui numbers its ids orc-tui-1 and orc-tui-2 instead of counting orc's orc-1", async () => {
    await withBacklog(async (root) => {
      await run(addTask(root, spec))
      expect((await run(addTask(root, { ...spec, project: "orc-tui" }))).spec.id).toBe("orc-tui-1")
      expect((await run(addTask(root, { ...spec, project: "orc-tui" }))).spec.id).toBe("orc-tui-2")
      expect((await run(addTask(root, spec))).spec.id).toBe("orc-2")
    })
  })
  test("an old task-3 id is still held, answered and closed instead of refused as no task id", async () => {
    for (const words of [["hold", "task-3", "--reason", "wait"], ["answer", "task-3", "go"], ["close", "task-3", "done"]]) {
      expect(parseDispatchArgs("backlog", words).kind).not.toBe("UsageError")
    }
    await withBacklog(async (root) => {
      await oldTask(root, "task-3", "orc")
      expect((await run(holdTask(root, "task-3", { reason: "wait", until: null, questions: [] }))).kind).toBe("held")
      await run(answerTask(root, "task-3", "go", "2026-10-27T10:30:00.000Z"))
      expect((await run(listTasks(root)))[0]?.hold?.answer?.words).toBe("go")
      await run(claimTask(root, "task-3"))
      await run(writeTaken(root, { spec: { ...spec, id: "task-3" }, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-10-27T10:32:00.000Z", log: root + "/logs/task-3.log" } } }))
      expect((await run(closeStartedTask(root, "task-3", "done", "merged", { pr: null, report: null }, "2026-10-27T11:00:00.000Z"))).state.kind).toBe("closed")
    })
  })
})
