import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { addTask, claimTask, findTask, rewriteNew, writeTaken, type TaskRecord } from "../../../packages/run/src/entities/backlog/index"
import { placeTask, runBeat } from "../../../packages/run/src/widgets/beat/beat"
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
      parked: { origin: { machine: "linux", run: "run-1" }, branch: "orc/task-1", questions: [{ id: "ask-1", text: "Which one?", asked: "2026-10-27T10:05:00.000Z", blocks: true, answer: { words: "Keep it", at: "2026-10-27T10:06:00.000Z", relayedTo: null } }] }
    }
    expect(placeTask(parked, config, projects, linuxFull)).toEqual({ kind: "waits", reason: "linux has no room" })
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
  test("starts nothing on the idle mac while only linux-parked tasks wait, then starts the next unmarked task there instead of leaving it waiting", async () => {
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
        Effect.succeed({ kind: "write" as const, record: { ...fresh, parked: { origin: { machine: "linux", run: "run-1" }, branch: "orc/" + parkedRecord.spec.id, questions: [{ id: "ask-1", text: "Which one?", asked: "2026-10-27T10:05:00.000Z", blocks: true, answer: { words: "Keep it", at: "2026-10-27T10:06:00.000Z", relayedTo: null } }] } }, result: null })
      ))
      const beat = () => Effect.runPromise(runBeat(root, root, quietSources()).pipe(Effect.provide(Layer.merge(BunServices.layer, quotaAnswering))))
      const first = await beat()
      expect(first.actions.filter((action) => action.kind === "started")).toEqual([])
      expect(first.actions.filter((action) => action.kind === "waits" && "task" in action && action.task === parkedRecord.spec.id)).toEqual([
        { kind: "waits", task: parkedRecord.spec.id, reason: "linux has no room" }
      ])
      const next = await run(addTask(root, spec))
      const second = await beat()
      expect(second.actions.filter((action) => action.kind === "started" && "task" in action && "machine" in action).map((action) => "task" in action && "machine" in action ? action.task + ":" + action.machine : "")).toEqual([next.spec.id + ":mac"])
    })
  })
})
