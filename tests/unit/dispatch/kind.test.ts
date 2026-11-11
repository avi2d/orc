import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { addTask, claimTask, listTasks, writeTaken } from "../../../packages/run/src/dispatch/backlog"
import { placeTask, runBeat } from "../../../packages/run/src/dispatch/beat"
import { quietSources } from "../../lib/beat-sources"
import { formatBeat } from "../../../packages/run/src/dispatch/board"
import type { DispatchConfig, Project } from "../../../packages/run/src/shared/config/dispatch-config"
import { taskLabel } from "../../../packages/run/src/dispatch/pueue-status"
import type { TaskRecord } from "../../../packages/run/src/dispatch/task-record"
import { insertRun, openDatabase } from "../../../packages/run/src/run-history"
import type { TaskKind } from "../../../packages/run/src/task-kind"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const withBacklog = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-kind-"))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const spec = { title: "Map the parser", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], created: "2026-10-27T10:00:00.000Z", body: "# Map the parser\n" }

const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-10-27T10:01:00.000Z" }

const started = { at: "2026-10-27T10:02:00.000Z", log: "/logs/task-1.log" }

const quota = { provider: "keyed", command: ["orc-quota"], accounts: [{ name: "main", kind: "token-file", tokenFile: "/secrets/main-token" }], floorPercent: 15 } as const

describe("a pinned scout or task", () => {
  const config: DispatchConfig = { machines: [{ name: "mac", slots: 1, start: ["true"] }, { name: "linux", slots: 4, start: ["true"] }], quota }
  const projects: ReadonlyArray<Project> = [{ name: "orc", checkouts: { mac: "/Users/a/orc", linux: "/home/a/orc" } }]
  const room = [{ machine: "mac", slots: 1, busy: 1 }, { machine: "linux", slots: 4, busy: 0 }]
  const pinned = (kind: TaskKind): TaskRecord => ({ spec: { ...spec, id: "task-1", kind, machine: "mac" }, hold: null, parked: null, state: { kind: "new" } })
  test("waits for its full machine instead of its kind letting it go to the one with room", () => {
    expect([placeTask(pinned("scout"), config, projects, room), placeTask(pinned("task"), config, projects, room)]).toEqual([
      { kind: "waits", reason: "mac has no room" },
      { kind: "waits", reason: "mac has no room" }
    ])
  })
})

const quotaReply = JSON.stringify({ schema: "orc.quota.v1", accounts: [{ name: "main", remainingPercent: 80 }] })

const pueueDone = (root: string): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> => {
  const status = JSON.stringify({ tasks: { "11": { id: 11, label: taskLabel(root, "task-1"), group: "orc", path: "/checkout", status: { Done: { start: started.at, end: "2026-10-27T10:05:00.000Z", result: "Success" } } } } })
  return Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner
    const reply = (text: string) => real.spawn(ChildProcess.make("sh", ["-c", "cat <<'J'\n" + text + "\nJ"]))
    return ChildProcessSpawner.make((command) =>
      ChildProcess.isStandardCommand(command) && command.command === "pueue"
        ? reply(status)
        : ChildProcess.isStandardCommand(command) && command.command === "orc-quota" ? reply(quotaReply) : real.spawn(command)
    )
  })).pipe(Layer.provide(BunServices.layer))
}

const startScout = async (root: string): Promise<void> => {
  await writeFile(join(root, "dispatch.json"), JSON.stringify({ machines: [{ name: "mac", slots: 1, start: ["orc", "runner", "start"] }], quota }))
  await writeFile(join(root, "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { mac: "/checkout" } }] }))
  await run(addTask(root, { ...spec, kind: "scout" }))
  await run(claimTask(root, "task-1"))
  await run(writeTaken(root, { spec: { ...spec, id: "task-1", kind: "scout" }, hold: null, parked: null, state: { kind: "started", claim, started } }))
  await run(Effect.acquireUseRelease(
    openDatabase(root),
    (db) => Effect.sync(() => insertRun(db, { id: "run-1", project: "/checkout", branch: "orc/task-1", taskFile: "task-1.md", status: "succeeded", started: started.at, prLink: null })),
    (db) => Effect.sync(() => db.close())
  ))
}

const beatClosing = async (root: string) => {
  const report = await Effect.runPromise(runBeat(root, root, quietSources()).pipe(Effect.provide(Layer.merge(BunServices.layer, pueueDone(root)))))
  const task = (await run(listTasks(root))).find((candidate) => candidate.spec.id === "task-1")
  return {
    closing: task?.state.kind === "closed" ? task.state.closing : null,
    lines: formatBeat(report).split("\n").filter((line) => line.startsWith("closed "))
  }
}

describe("the beat closing a scout", () => {
  test("a scout whose run wrote its report closes done with the report path instead of a PR", async () => {
    await withBacklog(async (root) => {
      await startScout(root)
      const report = join(root, "runs", "run-1", "agent-report.md")
      await mkdir(join(root, "runs", "run-1"), { recursive: true })
      await writeFile(report, "# Findings\n")
      const beat = await beatClosing(root)
      expect(beat.closing).toEqual({ outcome: "done", started, reason: "the run wrote its report", pr: null, report })
      expect(beat.lines).toEqual(["closed task-1 done on mac: the run wrote its report, report " + report])
    })
  })
  test("a scout whose run wrote no report closes failed even when pueue says it succeeded", async () => {
    await withBacklog(async (root) => {
      await startScout(root)
      expect((await beatClosing(root)).closing).toEqual({ outcome: "failed", started, reason: "the run wrote no report: pueue task 11 succeeded", pr: null, report: null })
    })
  })
})
