import { describe, expect, test } from "bun:test"
import type { TaskRecord } from "../../../packages/run/src/entities/backlog/index"
import { placeTask } from "../../../packages/run/src/widgets/beat/beat"
import type { DispatchConfig, Project } from "../../../packages/run/src/shared/config/dispatch-config"

const spec = { title: "Fix the thing", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0 as const, created: "2026-10-27T10:00:00.000Z", body: "# Fix the thing\n" }

const config: DispatchConfig = {
  machines: [{ name: "mac", slots: 1, start: ["true"] }, { name: "linux", slots: 4, start: ["true"] }],
  quota: { provider: "keyed", command: ["orc-quota"], accounts: [{ name: "main", kind: "token-file", tokenFile: "/secrets/main-token" }], floorPercent: 15 }
}

const projects: ReadonlyArray<Project> = [{ name: "orc", checkouts: { mac: "/Users/a/orc", linux: "/home/a/orc" } }]

const newTask = (machine: string | null): TaskRecord => ({ spec: { ...spec, id: "task-1", machine }, hold: null, parked: null, state: { kind: "new" } })

describe("placeTask", () => {
  const room = [{ machine: "mac", slots: 1, busy: 1 }, { machine: "linux", slots: 4, busy: 0 }]
  test("a task marked for a full machine waits instead of going to a machine with room", () => {
    expect(placeTask(newTask("mac"), config, projects, room)).toEqual({ kind: "waits", reason: "mac has no room" })
  })
  test("a task marked for a machine goes there even when another has more room", () => {
    const placement = placeTask(newTask("mac"), config, projects, [{ machine: "mac", slots: 1, busy: 0 }, { machine: "linux", slots: 4, busy: 0 }])
    expect(placement.kind === "place" ? placement.machine.name : placement.reason).toBe("mac")
  })
  test("an unmarked task goes to the machine with room instead of the first listed", () => {
    const placement = placeTask(newTask(null), config, projects, room)
    expect(placement.kind === "place" ? [placement.machine.name, placement.checkout] : placement.reason).toEqual(["linux", "/home/a/orc"])
  })
  test("a task marked for a machine with no checkout of its project waits", () => {
    const onlyMac: ReadonlyArray<Project> = [{ name: "orc", checkouts: { mac: "/Users/a/orc" } }]
    expect(placeTask(newTask("linux"), config, onlyMac, room).kind).toBe("waits")
  })
  const linuxFull = [{ machine: "mac", slots: 1, busy: 0 }, { machine: "linux", slots: 4, busy: 4 }]
  test("an unmarked task goes to the idle mac while the other machine is full instead of waiting", () => {
    const placement = placeTask(newTask(null), config, projects, linuxFull)
    expect(placement.kind === "place" ? placement.machine.name : placement.reason).toBe("mac")
  })
  test("a task parked on a full machine waits for it instead of resuming on the idle mac", () => {
    const parked: TaskRecord = {
      ...newTask(null),
      parked: { origin: { machine: "linux", run: "run-1" }, branch: "orc/task-1", questions: [{ id: "ask-1", text: "Which one?", asked: "2026-10-27T10:05:00.000Z", blocks: true, answer: null }] }
    }
    expect(placeTask(parked, config, projects, linuxFull)).toEqual({ kind: "waits", reason: "linux has no room" })
  })
})
