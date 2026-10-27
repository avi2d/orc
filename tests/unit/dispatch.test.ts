import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Result } from "effect"
import { parseDispatchArgs } from "../../packages/run/src/dispatch/args"
import { addTask, claimTask, closeStartedTask, listTasks, releaseTask, writeTaken } from "../../packages/run/src/dispatch/backlog"
import { placeTask } from "../../packages/run/src/dispatch/beat"
import { backlogJson, formatBoard } from "../../packages/run/src/dispatch/board"
import type { DispatchConfig, Project } from "../../packages/run/src/dispatch/config"
import { assessClauthStatus } from "../../packages/run/src/dispatch/quota"
import { parseTaskFile, renderTaskFile, type TaskRecord } from "../../packages/run/src/dispatch/task-record"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const withBacklog = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-dispatch-"))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const spec = { title: "Fix the thing", project: "orc", machine: null, dependsOn: [], created: "2026-10-27T10:00:00.000Z", body: "# Fix the thing\n" }

const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-10-27T10:01:00.000Z" }

const config: DispatchConfig = {
  machines: [{ name: "mac", slots: 1, start: ["true"] }, { name: "winbox", slots: 4, start: ["true"] }],
  quota: { accounts: ["main"], floorPercent: 15 }
}

const projects: ReadonlyArray<Project> = [{ name: "orc", checkouts: { mac: "/Users/a/orc", winbox: "/home/a/orc" } }]

const newTask = (machine: string | null): TaskRecord => ({ spec: { ...spec, id: "task-1", machine }, state: { kind: "new" } })

describe("parseDispatchArgs", () => {
  test("backlog with no argument shows the board, not JSON", () => {
    expect(parseDispatchArgs("backlog", [])).toEqual({ kind: "ShowBacklog", json: false })
  })
  test("backlog --json shows JSON", () => {
    expect(parseDispatchArgs("backlog", ["--json"])).toEqual({ kind: "ShowBacklog", json: true })
  })
  test("add keeps a repeated --depends-on instead of the last one only", () => {
    expect(parseDispatchArgs("backlog", ["add", "orc", "t.md", "--depends-on", "task-1", "--machine", "mac", "--depends-on", "task-2"])).toEqual({
      kind: "AddTask",
      project: "orc",
      taskFile: "t.md",
      machine: "mac",
      dependsOn: ["task-1", "task-2"]
    })
  })
  test("add refuses a second --machine instead of keeping either", () => {
    expect(parseDispatchArgs("backlog", ["add", "orc", "t.md", "--machine", "mac", "--machine", "winbox"]).kind).toBe("UsageError")
  })
  test("add refuses a flag with no value instead of taking the next flag as it", () => {
    expect(parseDispatchArgs("backlog", ["add", "orc", "t.md", "--machine", "--depends-on", "task-1"]).kind).toBe("UsageError")
  })
  test("close refuses an outcome other than done or failed", () => {
    expect(parseDispatchArgs("backlog", ["close", "task-1", "merged"]).kind).toBe("UsageError")
  })
  test("beat refuses an unknown argument instead of ignoring it", () => {
    expect(parseDispatchArgs("beat", ["--dry-run"])).toEqual({ kind: "UsageError", detail: "unexpected argument: --dry-run" })
  })
})

describe("task files", () => {
  test("a hand-written task file reads as a new task with its body intact", async () => {
    const text = "---\nid: task-7\ntitle: Fix the thing\nproject: orc\nmachine: mac\ndepends_on: [task-3]\ncreated: 2026-10-27T10:00:00.000Z\n---\n# Fix the thing\n\nDo it.\n"
    const record = await run(parseTaskFile("task-7.md", "new", text))
    expect(record).toEqual({
      spec: { id: "task-7", title: "Fix the thing", project: "orc", machine: "mac", dependsOn: ["task-3"], created: "2026-10-27T10:00:00.000Z", body: "# Fix the thing\n\nDo it.\n" },
      state: { kind: "new" }
    })
  })
  test("a body holding a --- line survives a write and a read instead of being cut there", async () => {
    const record: TaskRecord = {
      spec: { ...spec, id: "task-2", body: "Before\n---\nAfter\n" },
      state: { kind: "started", claim, started: { at: "2026-10-27T10:02:00.000Z", note: "queued 12" } }
    }
    expect(await run(parseTaskFile("task-2.md", "taken", renderTaskFile(record)))).toEqual(record)
  })
  test("a file with no frontmatter is refused instead of read as an empty task", async () => {
    const result = await run(Effect.result(parseTaskFile("task-1.md", "new", "# Just a title\n")))
    expect(Result.isFailure(result)).toBe(true)
  })
})

describe("assessClauthStatus", () => {
  const profile = (name: string, fiveHours: number, sevenDays: number) => ({
    name,
    auth_status: "ok",
    fetch_status: "Fresh",
    stale: false,
    windows: [{ label: "5h", utilization_pct: fiveHours }, { label: "7d", utilization_pct: sevenDays }]
  })
  test("room left is set by the fuller window, not the 5h window alone", () => {
    const reading = assessClauthStatus({ profiles: [profile("main", 20, 70)] }, { accounts: ["main"], floorPercent: 15 })
    expect(reading).toEqual({ kind: "read", floorPercent: 15, accounts: [{ account: "main", kind: "usable", remainingPercent: 30 }], pick: "main" })
  })
  test("runs use the account with most room, not the first listed", () => {
    const reading = assessClauthStatus({ profiles: [profile("main", 60, 60), profile("second", 10, 20)] }, { accounts: ["main", "second"], floorPercent: 15 })
    expect(reading.kind === "read" ? reading.pick : "unread").toBe("second")
  })
  test("an account below the floor is not picked", () => {
    const reading = assessClauthStatus({ profiles: [profile("main", 90, 10)] }, { accounts: ["main"], floorPercent: 15 })
    expect(reading.kind === "read" ? reading.pick : "unread").toBeNull()
  })
  test("a stale reading is unusable instead of trusted", () => {
    const reading = assessClauthStatus({ profiles: [{ ...profile("main", 0, 0), stale: true }] }, { accounts: ["main"], floorPercent: 15 })
    expect(reading.kind === "read" ? reading.accounts[0]?.kind : "unread").toBe("unusable")
  })
})

describe("placeTask", () => {
  const room = [{ machine: "mac", slots: 1, busy: 1 }, { machine: "winbox", slots: 4, busy: 0 }]
  test("a task marked for a full machine waits instead of going to a machine with room", () => {
    expect(placeTask(newTask("mac"), config, projects, room)).toEqual({ kind: "waits", reason: "mac has no room" })
  })
  test("a task marked for a machine goes there even when another has more room", () => {
    const placement = placeTask(newTask("mac"), config, projects, [{ machine: "mac", slots: 1, busy: 0 }, { machine: "winbox", slots: 4, busy: 0 }])
    expect(placement.kind === "place" ? placement.machine.name : placement.reason).toBe("mac")
  })
  test("an unmarked task goes to the machine with room instead of the first listed", () => {
    const placement = placeTask(newTask(null), config, projects, room)
    expect(placement.kind === "place" ? [placement.machine.name, placement.checkout] : placement.reason).toEqual(["winbox", "/home/a/orc"])
  })
  test("a task marked for a machine with no checkout of its project waits", () => {
    const onlyMac: ReadonlyArray<Project> = [{ name: "orc", checkouts: { mac: "/Users/a/orc" } }]
    expect(placeTask(newTask("winbox"), config, onlyMac, room).kind).toBe("waits")
  })
})

describe("the backlog folders", () => {
  test("of ten claims racing for one task exactly one wins instead of several", async () => {
    await withBacklog(async (root) => {
      const record = await run(addTask(root, spec))
      const wins = await run(Effect.all(Array.from({ length: 10 }, () => claimTask(root, record.spec.id)), { concurrency: "unbounded" }))
      expect(wins.filter(Boolean)).toHaveLength(1)
      expect(await readdir(join(root, "taken"))).toEqual(["task-1.md"])
      expect(await readdir(join(root, "new"))).toEqual([])
    })
  })
  test("tasks added at once take distinct ids instead of one id twice", async () => {
    await withBacklog(async (root) => {
      const records = await run(Effect.all(Array.from({ length: 8 }, () => addTask(root, spec)), { concurrency: "unbounded" }))
      expect(new Set(records.map((record) => record.spec.id)).size).toBe(8)
      expect((await run(listTasks(root))).map((record) => record.spec.id)).toEqual(Array.from({ length: 8 }, (_, index) => "task-" + (index + 1)))
    })
  })
  test("a taken task given back is new again instead of lost", async () => {
    await withBacklog(async (root) => {
      const record = await run(addTask(root, spec))
      await run(claimTask(root, record.spec.id))
      const taken: TaskRecord = { spec: record.spec, state: { kind: "taken", claim } }
      await run(writeTaken(root, taken))
      await run(releaseTask(root, taken))
      expect((await run(listTasks(root))).map((task) => task.state)).toEqual([{ kind: "new" }])
    })
  })
  test("a taken task that never started is refused a close instead of closed", async () => {
    await withBacklog(async (root) => {
      const record = await run(addTask(root, spec))
      await run(claimTask(root, record.spec.id))
      const result = await run(Effect.result(closeStartedTask(root, record.spec.id, "done", "", "2026-10-27T11:00:00.000Z")))
      expect(Result.isFailure(result)).toBe(true)
    })
  })
  test("a closed task leaves taken instead of being listed twice", async () => {
    await withBacklog(async (root) => {
      const record = await run(addTask(root, spec))
      await run(claimTask(root, record.spec.id))
      await run(writeTaken(root, { spec: record.spec, state: { kind: "started", claim, started: { at: "2026-10-27T10:02:00.000Z", note: "" } } }))
      await run(closeStartedTask(root, record.spec.id, "done", "merged", "2026-10-27T11:00:00.000Z"))
      const tasks = await run(listTasks(root))
      expect(tasks.map((task) => task.state.kind)).toEqual(["closed"])
      expect(await readdir(join(root, "taken"))).toEqual([])
    })
  })
})

describe("the board", () => {
  test("the JSON names its schema version so a reader can refuse a newer one", () => {
    const json = backlogJson({ tasks: [newTask("mac")], projects: { kind: "read", projects }, room: { kind: "unread", reason: "no dispatch.json" } })
    expect(json.schema).toBe("orc.backlog.v1")
    expect(json.tasks[0]).toEqual({ id: "task-1", title: "Fix the thing", project: "orc", machine: "mac", dependsOn: [], created: spec.created, status: "new" })
    expect(json.room).toBeNull()
  })
  test("the project list sits beside the backlog instead of under it", () => {
    const board = formatBoard({ tasks: [newTask("mac")], projects: { kind: "read", projects }, room: { kind: "read", room: [{ machine: "mac", slots: 1, busy: 0 }] } })
    const [header = "", first = ""] = board.split("\n")
    expect(header).toMatch(/^NEW \(1\) +TAKEN \(0\) +CLOSED \(0\) +PROJECTS$/)
    expect(first).toMatch(/^task-1 orc @mac Fix the thing +orc on mac,winbox$/)
  })
})
