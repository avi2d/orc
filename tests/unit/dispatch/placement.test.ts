import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { addTask, claimTask, findTask, rewriteNew, writeTaken, type TaskRecord } from "../../../packages/run/src/entities/backlog/index"
import { placeTask, runBeat } from "../../../packages/run/src/widgets/beat/beat"
import { beatJson } from "../../../packages/run/src/widgets/beat/board"
import type { DispatchConfig, Project } from "../../../packages/run/src/shared/config/dispatch-config"
import { quietSources } from "../../lib/beat-sources"

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
    expect(placeTask(newTask("mac"), config, projects, room)).toMatchObject({
      kind: "waits",
      reason: "mac has no room",
      machines: [
        { machine: "mac", kind: "rejected", code: "capacity", reason: "mac has no room" },
        { machine: "linux", kind: "rejected", code: "pin", reason: "the task is pinned to mac" }
      ]
    })
  })
  test("a task marked for a machine goes there even when another has more room", () => {
    const placement = placeTask(newTask("mac"), config, projects, [{ machine: "mac", slots: 1, busy: 0 }, { machine: "linux", slots: 4, busy: 0 }])
    expect(placement.kind === "place" ? placement.machine.name : placement.reason).toBe("mac")
  })
  test("an unmarked task goes to the machine with room instead of the first listed", () => {
    const placement = placeTask(newTask(null), config, projects, room)
    expect(placement.kind === "place" ? [placement.machine.name, placement.checkout] : placement.reason).toEqual(["linux", "/home/a/orc"])
  })
  test("a pinned task rejects a missing checkout without treating the other machine as eligible", () => {
    const onlyMac: ReadonlyArray<Project> = [{ name: "orc", checkouts: { mac: "/Users/a/orc" } }]
    expect(placeTask(newTask("linux"), config, onlyMac, room)).toMatchObject({
      kind: "waits",
      reason: "the project orc has no checkout on linux",
      machines: [
        { machine: "mac", kind: "rejected", code: "pin", reason: "the task is pinned to linux" },
        { machine: "linux", kind: "rejected", code: "no-checkout", reason: "the project orc has no checkout on linux" }
      ]
    })
  })
  test("the less roomy machine stays eligible when the roomier one wins", () => {
    const bothFree = [{ machine: "mac", slots: 1, busy: 0 }, { machine: "linux", slots: 4, busy: 0 }]
    expect(placeTask(newTask(null), config, projects, bothFree)).toMatchObject({
      kind: "place",
      machine: { name: "linux" },
      machines: [
        { machine: "mac", kind: "eligible" },
        { machine: "linux", kind: "eligible" }
      ]
    })
  })
  test("a full machine reports capacity instead of load even when both checks would reject it", () => {
    const overloaded = new Map([["mac", "mac's five-minute load is 8, above its limit of 4"]])
    expect(placeTask(newTask("mac"), config, projects, room, overloaded)).toMatchObject({
      kind: "waits",
      reason: "mac has no room",
      machines: [
        { machine: "mac", kind: "rejected", code: "capacity", reason: "mac has no room" },
        { machine: "linux", kind: "rejected", code: "pin", reason: "the task is pinned to mac" }
      ]
    })
  })
  const linuxFull = [{ machine: "mac", slots: 1, busy: 0 }, { machine: "linux", slots: 4, busy: 4 }]
  test("an unmarked task goes to the idle mac while the other machine is full instead of waiting", () => {
    const placement = placeTask(newTask(null), config, projects, linuxFull)
    expect(placement.kind === "place" ? placement.machine.name : placement.reason).toBe("mac")
  })
  test("a task parked on a full machine rejects the idle mac even when the task pins it", () => {
    const parked: TaskRecord = {
      ...newTask("mac"),
      parked: { origin: { machine: "linux", run: "run-1" }, branch: "orc/task-1", questions: [{ id: "ask-1", text: "Which one?", asked: "2026-10-27T10:05:00.000Z", blocks: true, answer: { decider: "owner" as const, words: "Keep it", at: "2026-10-27T10:06:00.000Z", relayedTo: null } }] }
    }
    expect(placeTask(parked, config, projects, linuxFull)).toMatchObject({
      kind: "waits",
      reason: "linux has no room",
      machines: [
        { machine: "mac", kind: "rejected", code: "parked-origin", reason: "the task is parked on linux" },
        { machine: "linux", kind: "rejected", code: "capacity", reason: "linux has no room" }
      ]
    })
  })
  const macPinnedOnly: DispatchConfig = { ...config, machines: [{ name: "mac", slots: 1, pinnedOnly: true, start: ["true"] }, { name: "linux", slots: 4, start: ["true"] }] }
  const parkedOnMac: TaskRecord = { ...newTask(null), parked: { origin: { machine: "mac", run: "run-1" }, branch: "orc/task-1", questions: [{ id: "ask-1", text: "Which one?", asked: "2026-10-27T10:05:00.000Z", blocks: true, answer: { decider: "owner" as const, words: "Keep it", at: "2026-10-27T10:06:00.000Z", relayedTo: null } }] } }
  test("an unpinned task parked on a pin-only mac resumes there instead of waiting forever for a pin", () => {
    expect(placeTask(parkedOnMac, macPinnedOnly, projects, linuxFull)).toMatchObject({
      kind: "place",
      machine: { name: "mac" },
      machines: [
        { machine: "mac", kind: "eligible" },
        { machine: "linux", kind: "rejected", code: "parked-origin", reason: "the task is parked on mac" }
      ]
    })
  })
  test("an unpinned task parked on a full pin-only mac waits for room there instead of skipping the slot limit", () => {
    expect(placeTask(parkedOnMac, macPinnedOnly, projects, room)).toMatchObject({
      kind: "waits",
      reason: "mac has no room",
      machines: [
        { machine: "mac", kind: "rejected", code: "capacity", reason: "mac has no room" },
        { machine: "linux", kind: "rejected", code: "parked-origin", reason: "the task is parked on mac" }
      ]
    })
  })
  test("an unpinned, unparked task still skips a pin-only mac instead of taking its idle slot", () => {
    expect(placeTask(newTask(null), macPinnedOnly, projects, linuxFull)).toMatchObject({
      kind: "waits",
      machines: [
        { machine: "mac", kind: "rejected", code: "pin-required", reason: "mac only runs tasks pinned to it" },
        { machine: "linux", kind: "rejected", code: "capacity", reason: "linux has no room" }
      ]
    })
  })
})

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const withBacklog = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-placement-"))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const quotaReply = JSON.stringify({ schema: "orc.quota.v1", accounts: [{ name: "main", remainingPercent: 80 }] })

const quotaAnswering = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
  const real = yield* ChildProcessSpawner.ChildProcessSpawner
  return ChildProcessSpawner.make((command) =>
    ChildProcess.isStandardCommand(command) && command.command === "orc-quota"
      ? real.spawn(ChildProcess.make("sh", ["-c", "cat <<'J'\n" + quotaReply + "\nJ"]))
      : real.spawn(command)
  )
})).pipe(Layer.provide(BunServices.layer))

describe("the beat over linux-parked tasks", () => {
  test("keeps each machine decision in beat JSON instead of reporting only the wait and start", async () => {
    await withBacklog(async (root) => {
      await writeFile(join(root, "dispatch.json"), JSON.stringify(config))
      await writeFile(join(root, "projects.json"), JSON.stringify({ projects }))
      const at = new Date().toISOString()
      for (let index = 0; index < 4; index += 1) {
        const record = await run(addTask(root, spec))
        await run(claimTask(root, record.spec.id))
        const fresh = await run(findTask(root, record.spec.id))
        await run(writeTaken(root, { ...fresh, state: { kind: "started", claim: { beat: "beat-1", machine: "linux", account: "main", takenAt: at }, started: { at, log: join(root, "logs", record.spec.id + ".log") } } }))
      }
      const parkedRecord = await run(addTask(root, spec))
      await run(rewriteNew(root, parkedRecord.spec.id, (fresh) =>
        Effect.succeed({ kind: "write" as const, record: { ...fresh, parked: { origin: { machine: "linux", run: "run-1" }, branch: "orc/" + parkedRecord.spec.id, questions: [{ id: "ask-1", text: "Which one?", asked: "2026-10-27T10:05:00.000Z", blocks: true, answer: { decider: "owner" as const, words: "Keep it", at: "2026-10-27T10:06:00.000Z", relayedTo: null } }] } }, result: null })
      ))
      const beat = () => Effect.runPromise(runBeat(root, root, quietSources()).pipe(Effect.provide(Layer.merge(BunServices.layer, quotaAnswering))))
      const first = await beat()
      expect(first.actions.filter((action) => action.kind === "started")).toEqual([])
      expect(first.actions.filter((action) => action.kind === "waits" && "task" in action && action.task === parkedRecord.spec.id)).toEqual([
        { kind: "waits", task: parkedRecord.spec.id, reason: "linux has no room" }
      ])
      expect(beatJson(first)).toMatchObject({
        placements: [{
          task: parkedRecord.spec.id,
          machines: [
            { machine: "mac", kind: "rejected", code: "parked-origin", reason: "the task is parked on linux" },
            { machine: "linux", kind: "rejected", code: "capacity", reason: "linux has no room" }
          ]
        }]
      })
      const next = await run(addTask(root, spec))
      const second = await beat()
      expect(second.actions.filter((action) => action.kind === "started" && "task" in action && "machine" in action).map((action) => "task" in action && "machine" in action ? action.task + ":" + action.machine : "")).toEqual([next.spec.id + ":mac"])
      expect(beatJson(second)).toMatchObject({
        placements: [
          {
            task: parkedRecord.spec.id,
            machines: [
              { machine: "mac", kind: "rejected", code: "parked-origin", reason: "the task is parked on linux" },
              { machine: "linux", kind: "rejected", code: "capacity", reason: "linux has no room" }
            ]
          },
          {
            task: next.spec.id,
            machines: [
              { machine: "mac", kind: "eligible" },
              { machine: "linux", kind: "rejected", code: "capacity", reason: "linux has no room" }
            ]
          }
        ]
      })
    })
  })
})
