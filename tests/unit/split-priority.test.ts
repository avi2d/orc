import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { addTask, applyRunSplit, applySplit, claimTask, listTasks, writeTaken } from "../../packages/run/src/entities/backlog/index"
import type { SplitPlan } from "../../packages/run/src/entities/backlog/split"
import { answerTask, parkStartedTask } from "../../packages/run/src/entities/parked-runs/parked"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-11-14T10:01:00.000Z" }
const started = { at: "2026-11-14T10:02:00.000Z", log: "/logs/orc-1.log" }

const spec = { title: "Ship task splitting", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 2 as const, created: "2026-11-14T10:00:00.000Z", body: "# Ship task splitting\n" }

const plan = {
  schema: "orc.split.v1",
  plan: "split",
  reason: "it touches the record and the listing",
  done: ["a big change lands as linked children"],
  children: [
    { title: "Record the split", body: "Add the split mark.", after: [] },
    { title: "Show the plan", body: "List the children.", after: [1] }
  ]
} satisfies SplitPlan

const withRoot = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-split-priority-"))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("a split keeps the priority of the task that proposed it", () => {
  test("a split request at P2 gives its parent and every child P2 instead of dropping it", async () => {
    await withRoot(async (root) => {
      await run(applySplit(root, { ...spec, priority: 2 as const }, plan, "intake"))
      const tasks = await run(listTasks(root))
      expect(tasks.map((task) => [task.spec.id, task.spec.kind, task.spec.priority])).toEqual([
        ["orc-1", "parent", 2],
        ["orc-2", "ship", 2],
        ["orc-3", "ship", 2]
      ])
    })
  })

  test("a worker split of a P2 task gives its parent and every child P2 instead of dropping it", async () => {
    await withRoot(async (root) => {
      await run(addTask(root, spec))
      await run(claimTask(root, "orc-1"))
      const task = { spec: { ...spec, id: "orc-1" }, hold: null, parked: null, state: { kind: "started" as const, claim, started } }
      await run(writeTaken(root, task))
      await run(applyRunSplit(root, task, plan, "2026-11-14T10:05:00.000Z"))
      const tasks = await run(listTasks(root))
      expect(tasks.map((item) => [item.spec.id, item.spec.kind, item.spec.priority])).toEqual([
        ["orc-1", "parent", 2],
        ["orc-2", "ship", 2],
        ["orc-3", "ship", 2]
      ])
    })
  })

  test("a parked P2 task keeps P2 through its park and its answer instead of resuming at no priority", async () => {
    await withRoot(async (root) => {
      await run(addTask(root, spec))
      await run(claimTask(root, "orc-1"))
      await run(writeTaken(root, { spec: { ...spec, id: "orc-1" }, hold: null, parked: null, state: { kind: "started", claim, started } }))
      await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ id: "q1", text: "Which way?", asked: "run-1" }], "2026-11-14T10:10:00.000Z"))
      expect((await run(listTasks(root))).map((task) => [task.spec.id, task.state.kind, task.spec.priority])).toEqual([["orc-1", "new", 2]])
      await run(answerTask(root, "orc-1", "q1=Left", "2026-11-14T10:20:00.000Z"))
      expect((await run(listTasks(root))).map((task) => [task.spec.id, task.spec.priority])).toEqual([["orc-1", 2]])
    })
  })
})
