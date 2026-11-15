import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { addTask, type TaskRecord } from "../../../packages/run/src/entities/backlog/index"
import { runBeat } from "../../../packages/run/src/widgets/beat/beat"
import { readBeatWaits } from "../../../packages/run/src/widgets/beat/beat-waits"
import { backlogJson, type BacklogView } from "../../../packages/run/src/widgets/beat/board"
import { taskPrState } from "../../../packages/run/src/widgets/beat/task-events"
import type { DispatchConfig, Project } from "../../../packages/run/src/shared/config/dispatch-config"
import { quietSources } from "../../lib/beat-sources"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const withBacklog = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-waiting-"))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const spec = { title: "Fix the thing", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0 as const, created: "2026-10-27T10:00:00.000Z", body: "# Fix the thing\n" }

const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-10-27T10:01:00.000Z" }

const config: DispatchConfig = {
  machines: [{ name: "mac", slots: 1, start: ["true"] }],
  quota: { provider: "keyed", command: ["orc-quota"], accounts: [{ name: "main", kind: "token-file", tokenFile: "/secrets/main-token" }], floorPercent: 15 }
}

const projects: ReadonlyArray<Project> = [{ name: "orc", checkouts: { mac: "/checkout" } }]

const quotaReply = JSON.stringify({ schema: "orc.quota.v1", accounts: [{ name: "main", remainingPercent: 80 }] })

// Answers the quota command itself and runs every other command for real.
const quotaAnswering = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
  const real = yield* ChildProcessSpawner.ChildProcessSpawner
  return ChildProcessSpawner.make((command) =>
    ChildProcess.isStandardCommand(command) && command.command === "orc-quota"
      ? real.spawn(ChildProcess.make("sh", ["-c", "cat <<'J'\n" + quotaReply + "\nJ"]))
      : real.spawn(command)
  )
})).pipe(Layer.provide(BunServices.layer))

const viewOf = (tasks: ReadonlyArray<TaskRecord>, beatWaits: BacklogView["beatWaits"] = null): BacklogView =>
  ({ tasks, events: [], projects: { kind: "read", projects }, room: { kind: "read", room: [] }, merged: new Set(), prStates: new Map(), beatWaits, deciderOwns: () => false })

const waitingOf = (tasks: ReadonlyArray<TaskRecord>, id: string, beatWaits: BacklogView["beatWaits"] = null) =>
  backlogJson(viewOf(tasks, beatWaits)).tasks.find((task) => task.id === id)?.waiting

const asNew = (id: string, change: Partial<TaskRecord> = {}, specChange: Partial<TaskRecord["spec"]> = {}): TaskRecord =>
  ({ spec: { ...spec, id, ...specChange }, hold: null, parked: null, state: { kind: "new" }, ...change })

const closedWithPr = (id: string, pr: string | null): TaskRecord => ({
  spec: { ...spec, id },
  hold: null,
  parked: null,
  state: { kind: "closed", claim, closing: { outcome: "done", started: { at: "2026-10-27T10:02:00.000Z", log: "/logs/" + id + ".log" }, reason: "the run opened a PR", pr, report: null }, closedAt: "2026-10-27T11:00:00.000Z", postedAt: null }
})

describe("why a new task waits in backlog --json", () => {
  test("a task with no priority reads no-priority instead of room, so a board keeps it in Backlog rather than Planned", () => {
    expect(waitingOf([asNew("orc-1", {}, { priority: null })], "orc-1")).toEqual({ kind: "no-priority", detail: "no priority" })
  })
  test("a decision reads decision instead of room, so a board shows it to the captain rather than as Planned", () => {
    expect(waitingOf([asNew("orc-1", {}, { kind: "decision" })], "orc-1")).toEqual({ kind: "decision", detail: "decision for the captain" })
  })
  test("a held task reads held with its reason instead of room, so a board shows it awaiting the captain rather than Planned", () => {
    const hold = { reason: "which API shape", until: null, questions: [], answer: null, at: null }
    expect(waitingOf([asNew("orc-1", { hold })], "orc-1")).toEqual({ kind: "held", detail: "held for the captain: which API shape" })
  })
  test("a parked task reads parked instead of held, so a board names the open question rather than a hold", () => {
    const parked = { origin: { machine: "mac", run: "run-1" }, branch: "orc/orc-1", questions: [{ id: "q1", text: "Which table?", asked: "2026-10-27T10:03:00.000Z", blocks: true, answer: null }] } as const
    expect(waitingOf([asNew("orc-1", { parked })], "orc-1")).toEqual({ kind: "parked", detail: "parked on orc/orc-1 for the captain's answer to q1" })
  })
  test("a task on an open dependency reads depends instead of room, so a board keeps it behind that task rather than Planned", () => {
    const tasks = [asNew("orc-1", {}, { dependsOn: ["orc-2"] }), asNew("orc-2")]
    expect(waitingOf(tasks, "orc-1")).toEqual({ kind: "depends", detail: "waits on orc-2" })
  })
  test("a ready task no beat has looked at reads room with a null detail instead of a reason nobody gave", () => {
    expect(waitingOf([asNew("orc-1")], "orc-1")).toEqual({ kind: "room", detail: null, at: null })
  })
  test("a ready task reads room with the last beat's words and time instead of no reason", () => {
    const beatWaits = { at: "2026-10-27T10:05:00.000Z", reasons: new Map([["orc-1", "no machine with a checkout of orc has room"]]) }
    expect(waitingOf([asNew("orc-1")], "orc-1", beatWaits)).toEqual({ kind: "room", detail: "no machine with a checkout of orc has room", at: "2026-10-27T10:05:00.000Z" })
  })
  test("a taken, started or closed task reads no wait instead of the reason it waited for while new", () => {
    const taken: TaskRecord = { ...asNew("orc-1"), state: { kind: "taken", claim } }
    const started: TaskRecord = { ...asNew("orc-2"), state: { kind: "started", claim, started: { at: "2026-10-27T10:02:00.000Z", log: "/logs/orc-2.log" } } }
    const tasks = [taken, started, closedWithPr("orc-3", null)]
    expect(backlogJson(viewOf(tasks)).tasks.map((task) => task.waiting)).toEqual([null, null, null])
  })
  test("a later beat's reason replaces an earlier beat's instead of the board showing a reason that no longer holds", async () => {
    await withBacklog(async (root) => {
      const beat = () => Effect.runPromise(runBeat(root, root, quietSources()).pipe(Effect.provide(Layer.merge(BunServices.layer, quotaAnswering))))
      await writeFile(join(root, "projects.json"), JSON.stringify({ projects }))
      await writeFile(join(root, "dispatch.json"), JSON.stringify({ ...config, machines: [{ name: "mac", slots: 0, start: ["true"] }] }))
      await run(addTask(root, spec))
      await beat()
      expect((await run(readBeatWaits(root)))?.reasons.get("orc-1")).toBe("no machine with a checkout of orc has room")
      await writeFile(join(root, "dispatch.json"), JSON.stringify({ ...config, machines: [{ name: "mac", slots: 1, start: ["true"] }], quota: { ...config.quota, floorPercent: 90 } }))
      const second = await beat()
      const waits = await run(readBeatWaits(root))
      expect([waits?.at, waits?.reasons.get("orc-1")]).toEqual([second.at, "no keyed account has room"])
    })
  })
})

describe("a task's PR state in backlog --json", () => {
  const pr = "https://github.com/example/repo/pull/1"
  const recordEvent = async (root: string, key: string): Promise<void> => {
    await mkdir(join(root, "events"), { recursive: true })
    await writeFile(join(root, "events", key + ".json"), JSON.stringify({ at: "2026-10-27T12:00:00.000Z", text: key }))
  }
  test("a task with no PR reads null instead of open, so a board does not wait on a PR that does not exist", async () => {
    await withBacklog(async (root) => {
      expect(await run(taskPrState(root, closedWithPr("orc-1", null)))).toBeNull()
    })
  })
  test("a PR with no merge or close recorded reads open instead of null, so a board shows it awaiting the captain rather than Done", async () => {
    await withBacklog(async (root) => {
      expect(await run(taskPrState(root, closedWithPr("orc-1", pr)))).toBe("open")
    })
  })
  test("a PR with a merged event reads merged instead of open, so a board shows it Done rather than awaiting the captain", async () => {
    await withBacklog(async (root) => {
      await recordEvent(root, "orc-1.merged")
      expect(await run(taskPrState(root, closedWithPr("orc-1", pr)))).toBe("merged")
    })
  })
  test("a PR with a pr-closed event reads closed instead of open or merged, so a board does not count an unmerged PR as Done", async () => {
    await withBacklog(async (root) => {
      await recordEvent(root, "orc-1.pr-closed")
      expect(await run(taskPrState(root, closedWithPr("orc-1", pr)))).toBe("closed")
    })
  })
})
