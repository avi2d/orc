import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { addTask, applyRunSplit, applySplit, claimTask, listTasks, parseTaskFile, renderTaskFile, TaskFileError, type TaskPriority, writeTaken } from "../../../packages/run/src/entities/backlog/index"
import { prioritizeTask } from "../../../packages/run/src/features/backlog-planning/index"
import { parseDispatchArgs } from "../../../packages/run/src/app/dispatch-args"
import { runBeat } from "../../../packages/run/src/widgets/beat/beat"
import { backlogJson, formatBeat, formatBoard } from "../../../packages/run/src/widgets/beat/board"
import { quietSources } from "../../lib/beat-sources"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const spec = { title: "Order the beat", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: null, created: "2026-11-01T10:00:00.000Z", body: "# Order the beat\n" }
const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-11-01T10:01:00.000Z" }
const started = { at: "2026-11-01T10:02:00.000Z", log: "/logs/orc-1.log" }
const quota = { provider: "keyed", command: ["orc-quota"], accounts: [{ name: "main", kind: "token-file", tokenFile: "/secrets/main-token" }], floorPercent: 15 } as const
const quotaReply = JSON.stringify({ schema: "orc.quota.v1", accounts: [{ name: "main", remainingPercent: 80 }] })
const plan = {
  schema: "orc.split.v1" as const,
  plan: "split" as const,
  reason: "two areas",
  done: ["both areas land"],
  children: [{ title: "First slice", body: "Do one.", after: [] }, { title: "Second slice", body: "Do two.", after: [1] }]
}

const quotaOnly: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
  const real = yield* ChildProcessSpawner.ChildProcessSpawner
  return ChildProcessSpawner.make((command) =>
    ChildProcess.isStandardCommand(command) && command.command === "orc-quota"
      ? real.spawn(ChildProcess.make("sh", ["-c", "cat <<'J'\n" + quotaReply + "\nJ"]))
      : real.spawn(command)
  )
})).pipe(Layer.provide(BunServices.layer))

const withBacklog = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-priority-"))
  try {
    await writeFile(join(root, "dispatch.json"), JSON.stringify({ machines: [{ name: "mac", slots: 1, start: ["true"] }], quota }))
    await writeFile(join(root, "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { mac: "/checkout" } }] }))
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const addAt = (root: string, created: string, priority: TaskPriority | null) => run(addTask(root, { ...spec, created, priority }))

const startedIds = async (root: string): Promise<ReadonlyArray<string>> => {
  const report = await Effect.runPromise(runBeat(root, root, quietSources()).pipe(Effect.provide(Layer.merge(BunServices.layer, quotaOnly))))
  return report.actions.flatMap((action) => action.kind === "started" ? [action.task] : [])
}

describe("the beat's start order", () => {
  test("a P0 task takes the last slot before an older P2 task instead of the older one starting first", async () => {
    await withBacklog(async (root) => {
      await addAt(root, "2026-11-01T09:00:00.000Z", 2)
      await addAt(root, "2026-11-01T11:00:00.000Z", 0)
      expect(await startedIds(root)).toEqual(["orc-2"])
    })
  })
  test("a task with no priority waits behind a newer P4 task instead of ranking as P0", async () => {
    await withBacklog(async (root) => {
      await addAt(root, "2026-11-01T09:00:00.000Z", null)
      await addAt(root, "2026-11-01T11:00:00.000Z", 4)
      expect(await startedIds(root)).toEqual(["orc-2"])
    })
  })
  test("of two P1 tasks the older starts first instead of the lower id", async () => {
    await withBacklog(async (root) => {
      await addAt(root, "2026-11-01T11:00:00.000Z", 1)
      await addAt(root, "2026-11-01T09:00:00.000Z", 1)
      expect(await startedIds(root)).toEqual(["orc-2"])
    })
  })
  test("a task with no priority waits with the reason no priority instead of starting on a free slot", async () => {
    await withBacklog(async (root) => {
      await addAt(root, spec.created, null)
      const beatOnce = () => Effect.runPromise(runBeat(root, root, quietSources()).pipe(Effect.provide(Layer.merge(BunServices.layer, quotaOnly))))
      const first = await beatOnce()
      expect(first.actions).toEqual([{ kind: "waits", task: "orc-1", reason: "no priority" }])
      expect(formatBeat(first)).toContain("waits orc-1: no priority")
      const second = await beatOnce()
      expect(second.actions).toEqual([{ kind: "waits", task: "orc-1", reason: "no priority" }])
      expect(formatBeat(second)).toContain("waits orc-1: no priority")
      expect((await run(listTasks(root))).map((task) => task.spec.id + ":" + task.state.kind)).toEqual(["orc-1:new"])
    })
  })
})

describe("orc backlog priority", () => {
  test("a priority on a started task is refused instead of rewriting the file its run owns", async () => {
    await withBacklog(async (root) => {
      await addAt(root, spec.created, null)
      await run(claimTask(root, "orc-1"))
      await run(writeTaken(root, { spec: { ...spec, id: "orc-1" }, hold: null, parked: null, state: { kind: "started", claim, started } }))
      const file = join(root, "taken", "orc-1.md")
      const before = await readFile(file, "utf8")
      const refused = await run(Effect.flip(prioritizeTask(root, "orc-1", 0)))
      expect(refused.detail).toBe("orc-1 is started, and only a new task takes a priority")
      expect(await readFile(file, "utf8")).toBe(before)
    })
  })
  test("a new task takes a priority and none clears it instead of keeping the old one", async () => {
    await withBacklog(async (root) => {
      await addAt(root, spec.created, null)
      expect(await run(prioritizeTask(root, "orc-1", 3))).toBe("set")
      expect((await run(listTasks(root)))[0]?.spec.priority).toBe(3)
      expect(await run(prioritizeTask(root, "orc-1", 3))).toBe("unchanged")
      expect(await run(prioritizeTask(root, "orc-1", null))).toBe("set")
      expect(await readFile(join(root, "new", "orc-1.md"), "utf8")).not.toContain("priority")
    })
  })
  test("the command reads 0 to 4 or none and refuses 5 instead of storing it", () => {
    expect(parseDispatchArgs("backlog", ["priority", "orc-1", "0"])).toEqual({ kind: "PrioritizeTask", id: "orc-1", priority: 0 })
    expect(parseDispatchArgs("backlog", ["priority", "orc-1", "none"])).toEqual({ kind: "PrioritizeTask", id: "orc-1", priority: null })
    expect(parseDispatchArgs("backlog", ["priority", "orc-1", "5"]).kind).toBe("UsageError")
    expect(parseDispatchArgs("backlog", ["priority", "orc-1", "P1"]).kind).toBe("UsageError")
  })
  test("add reads --priority and refuses a second one instead of keeping the last", () => {
    expect(parseDispatchArgs("backlog", ["add", "orc", "t.md", "--priority", "2"])).toMatchObject({ kind: "AddTask", priority: 2 })
    expect(parseDispatchArgs("backlog", ["add", "orc", "t.md", "--priority", "1", "--priority", "2"]).kind).toBe("UsageError")
    expect(parseDispatchArgs("backlog", ["add", "orc", "t.md", "--priority", "-1"]).kind).toBe("UsageError")
  })
})

describe("a priority in the task file", () => {
  test("a task file with no priority key reads as no priority instead of being refused or read as P0", async () => {
    const text = ["---", "id: orc-1", "title: Order the beat", "project: orc", "machine: null", "depends_on: []", "created: 2026-11-01T10:00:00.000Z", "---", "# Order the beat", ""].join("\n")
    const record = await run(parseTaskFile("orc-1.md", "new", text))
    expect(record.spec.priority).toBeNull()
    expect(renderTaskFile(record)).not.toContain("priority")
  })
  test("a priority survives a write and a read instead of being dropped", async () => {
    const record = { spec: { ...spec, id: "orc-1", priority: 0 as const }, hold: null, parked: null, state: { kind: "new" as const } }
    expect(await run(parseTaskFile("orc-1.md", "new", renderTaskFile(record)))).toEqual(record)
  })
  test("a priority of 7 in the file is refused instead of ranking past no priority", async () => {
    const text = ["---", "id: orc-1", "title: T", "project: orc", "machine: null", "depends_on: []", "priority: 7", "created: 2026-11-01T10:00:00.000Z", "---", "# T", ""].join("\n")
    expect(await run(Effect.flip(parseTaskFile("orc-1.md", "new", text)))).toBeInstanceOf(TaskFileError)
  })
})

describe("a priority across a split", () => {
  test("an intake split gives the parent and every child the requested priority instead of none", async () => {
    await withBacklog(async (root) => {
      const applied = await run(applySplit(root, { title: spec.title, project: "orc", internal: false, machine: null, dependsOn: [], priority: 0 as const, created: spec.created, body: spec.body }, plan, "intake"))
      expect([applied.parent, ...applied.children].map((task) => task.spec.priority)).toEqual([0, 0, 0])
      expect((await run(listTasks(root))).map((task) => task.spec.priority)).toEqual([0, 0, 0])
    })
  })
  test("a run split gives the children the priority of the task it splits instead of ranking them last", async () => {
    await withBacklog(async (root) => {
      await addAt(root, spec.created, 1)
      await run(claimTask(root, "orc-1"))
      const task = { spec: { ...spec, id: "orc-1", priority: 1 as const }, hold: null, parked: null, state: { kind: "started" as const, claim, started } }
      await run(writeTaken(root, task))
      const applied = await run(applyRunSplit(root, task, plan, "2026-11-01T12:00:00.000Z"))
      expect([applied.parent, ...applied.children].map((child) => child.spec.priority)).toEqual([1, 1, 1])
    })
  })
})

describe("the backlog listing", () => {
  test("shows P<n> beside a prioritized id and gives every task a priority in JSON instead of leaving the key out", async () => {
    await withBacklog(async (root) => {
      await addAt(root, "2026-11-01T09:00:00.000Z", 2)
      await addAt(root, "2026-11-01T10:00:00.000Z", null)
      const tasks = await run(listTasks(root))
      const view = { tasks, events: [], projects: { kind: "read" as const, projects: [] }, room: { kind: "read" as const, room: [] }, merged: new Set<string>(), prStates: new Map(), deciderOwns: () => false }
      expect(backlogJson(view).tasks.map((task) => task.priority)).toEqual([2, null])
      const board = formatBoard(view)
      expect(board).toContain("orc-1 P2 orc")
      expect(board).toContain("orc-2 orc")
    })
  })
})
