import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { parseDispatchArgs } from "../../../packages/run/src/dispatch/args"
import { addTask, claimTask, closeStartedTask, listTasks, writeTaken } from "../../../packages/run/src/dispatch/backlog"
import { runBeat } from "../../../packages/run/src/dispatch/beat"
import { ownLogEndingOf, staleEndingOf } from "../../../packages/run/src/dispatch/beat-close"
import { taskLabel } from "../../../packages/run/src/dispatch/pueue-status"
import { killHeld } from "../../../packages/run/src/dispatch/runner"
import { endingFromResult } from "../../../packages/run/src/dispatch/runner-result"
import { renderTaskFile } from "../../../packages/run/src/dispatch/task-record-render"
import { markRunStopped } from "../../../packages/run/src/history-write"
import { insertRun, openDatabase, recordStep, runById, stoppedEndReason } from "../../../packages/run/src/run-history"
import { stepsForRun } from "../../../packages/run/src/history-resume"
import type { DispatchConfig, Project } from "../../../packages/run/src/dispatch/config"
import { quietSources } from "../../lib/beat-sources"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const withBacklog = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-stop-"))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const spec = { title: "Fix the thing", project: "orc", kind: "ship" as const, internal: false, machine: null, dependsOn: [], created: "2026-10-27T10:00:00.000Z", body: "# Fix the thing\n" }

const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-10-27T10:01:00.000Z" }

const config: DispatchConfig = {
  machines: [{ name: "mac", slots: 1, start: ["orc", "runner", "start"] }],
  quota: { provider: "keyed", command: ["orc-quota"], accounts: [{ name: "main", kind: "token-file", tokenFile: "/secrets/main-token" }], floorPercent: 15 }
}

const projects: ReadonlyArray<Project> = [{ name: "orc", checkouts: { mac: "/checkout" } }]

type BeatSpawner = Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>

const pueueStub = (statusJson: string): BeatSpawner =>
  Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner
    return ChildProcessSpawner.make((command) =>
      ChildProcess.isStandardCommand(command) && command.command === "pueue"
        ? real.spawn(ChildProcess.make("sh", ["-c", "cat <<'J'\n" + statusJson + "\nJ"]))
        : real.spawn(command)
    )
  })).pipe(Layer.provide(BunServices.layer))

const pueueKillRefusing = (statusJson: string): BeatSpawner =>
  Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner
    return ChildProcessSpawner.make((command) =>
      ChildProcess.isStandardCommand(command) && command.command === "pueue" && command.args.includes("kill")
        ? real.spawn(ChildProcess.make("sh", ["-c", "echo 'The command failed for tasks: 11' >&2; exit 1"]))
        : ChildProcess.isStandardCommand(command) && command.command === "pueue"
          ? real.spawn(ChildProcess.make("sh", ["-c", "cat <<'J'\n" + statusJson + "\nJ"]))
          : real.spawn(command)
    )
  })).pipe(Layer.provide(BunServices.layer))

const pueueFailing: BeatSpawner =
  Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner
    return ChildProcessSpawner.make((command) =>
      ChildProcess.isStandardCommand(command) && command.command === "pueue"
        ? real.spawn(ChildProcess.make("sh", ["-c", "echo pueue is down >&2; exit 3"]))
        : real.spawn(command)
    )
  })).pipe(Layer.provide(BunServices.layer))

const startTaskOne = async (root: string, start: ReadonlyArray<string>, at: string): Promise<void> => {
  await writeFile(join(root, "dispatch.json"), JSON.stringify({ ...config, machines: [{ name: "mac", slots: 1, start }] }))
  await writeFile(join(root, "projects.json"), JSON.stringify({ projects }))
  await run(addTask(root, spec))
  await run(claimTask(root, "orc-1"))
  const first = (await run(listTasks(root))).find((task) => task.spec.id === "orc-1")
  if (first === undefined) {
    throw new Error("the backlog holds no orc-1")
  }
  await run(writeTaken(root, { spec: first.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at, log: root + "/logs/orc-1.log" } } }))
}

const oldStart = "2026-10-27T10:02:00.000Z"

describe("stop and kill args", () => {
  test("backlog stop takes one task id instead of closing by outcome", () => {
    expect(parseDispatchArgs("backlog", ["stop", "task-1"])).toEqual({ kind: "StopTask", id: "task-1" })
  })
  test("backlog stop refuses a second word and a missing id instead of stopping a guess", () => {
    expect(parseDispatchArgs("backlog", ["stop", "task-1", "now"]).kind).toBe("UsageError")
    expect(parseDispatchArgs("backlog", ["stop"]).kind).toBe("UsageError")
    expect(parseDispatchArgs("backlog", ["stop", "../task-1"]).kind).toBe("UsageError")
  })
  test("runner kill takes a task id instead of queuing one", () => {
    expect(parseDispatchArgs("runner", ["kill", "task-1"])).toEqual({ kind: "RunnerKill", task: "task-1", stdinLabel: false })
  })
  test("runner kill reads a label but refuses a reach instead of handing work to a far shell", () => {
    expect(parseDispatchArgs("runner", ["kill", "task-1", "--label", "home task-1"])).toEqual({
      kind: "RunnerKill",
      task: "task-1",
      label: "home task-1",
      stdinLabel: false
    })
    expect(parseDispatchArgs("runner", ["kill", "task-1", "--", "ssh", "linux", "orc"]).kind).toBe("UsageError")
    expect(parseDispatchArgs("runner", ["kill", "../task-1"]).kind).toBe("UsageError")
  })
})

describe("a task closed stopped", () => {
  test("a stopped task keeps its start and reason instead of dropping to start-failed", async () => {
    await withBacklog(async (root) => {
      await run(addTask(root, spec))
      await run(claimTask(root, "orc-1"))
      const first = (await run(listTasks(root))).find((task) => task.spec.id === "orc-1")
      if (first === undefined) {
        throw new Error("the backlog holds no orc-1")
      }
      await run(writeTaken(root, { spec: first.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: oldStart, log: root + "/logs/orc-1.log" } } }))
      await run(closeStartedTask(root, "orc-1", "stopped", "the captain stopped orc-1", { pr: null, report: null }, "2026-10-27T10:03:00.000Z"))
      const closed = (await run(listTasks(root))).find((task) => task.spec.id === "orc-1")
      if (closed?.state.kind !== "closed") {
        throw new Error("orc-1 never closed")
      }
      expect(closed.state.closing.outcome).toBe("stopped")
      expect(closed.state.closing.reason).toBe("the captain stopped orc-1")
      expect(renderTaskFile(closed)).toContain("outcome: \"stopped\"")
    })
  })
})

describe("runner kill", () => {
  test("kill refuses a task pueue never held instead of killing by id", async () => {
    await withBacklog(async (root) => {
      const spawner = pueueStub(JSON.stringify({ tasks: {} }))
      const detail = await Effect.runPromise(
        Effect.flip(killHeld(root, "orc-1", taskLabel(root, "orc-1"))).pipe(
          Effect.map((error) => error.detail),
          Effect.provide(Layer.merge(BunServices.layer, spawner))
        )
      )
      expect(detail).toBe("orc-1 has no pueue task in group orc, so nothing stops it")
    })
  })
  test("kill refuses a finished pueue task instead of killing it again", async () => {
    await withBacklog(async (root) => {
      const spawner = pueueStub(JSON.stringify({ tasks: { "11": { id: 11, label: taskLabel(root, "orc-1"), group: "orc", path: "/checkout", status: { Done: { start: oldStart, end: "2026-10-27T10:05:00.000Z", result: "Success" } } } } }))
      const detail = await Effect.runPromise(
        Effect.flip(killHeld(root, "orc-1", taskLabel(root, "orc-1"))).pipe(
          Effect.map((error) => error.detail),
          Effect.provide(Layer.merge(BunServices.layer, spawner))
        )
      )
      expect(detail).toBe("orc-1 already finished as pueue task 11, so nothing stops it")
    })
  })
  test("kill removes a queued pueue task instead of failing on a run that never started", async () => {
    await withBacklog(async (root) => {
      const spawner = pueueKillRefusing(JSON.stringify({ tasks: { "11": { id: 11, label: taskLabel(root, "orc-1"), group: "orc", path: "/checkout", status: { Queued: {} } } } }))
      const line = await Effect.runPromise(
        killHeld(root, "orc-1", taskLabel(root, "orc-1")).pipe(Effect.provide(Layer.merge(BunServices.layer, spawner)))
      )
      expect(line).toBe("removed pueue task 11 for orc-1")
    })
  })
  test("kill stops the pueue task and marks its run stopped instead of leaving it running", async () => {
    await withBacklog(async (root) => {
      await Effect.runPromise(Effect.acquireUseRelease(
        openDatabase(root),
        (db) => Effect.gen(function*() {
          insertRun(db, { id: "run-1", project: "/checkout", branch: "orc/orc-1", taskFile: "orc-1.md", status: "running", started: oldStart, prLink: "https://github.com/example/orc/pull/7" })
          yield* recordStep(db, { runId: "run-1", name: "implement", attempt: 1, status: "running", started: oldStart, agentFile: "agent.md", piSessionFile: "sessions/s.jsonl" })
        }),
        (db) => Effect.sync(() => db.close())
      ).pipe(Effect.provide(BunServices.layer)))
      const spawner = pueueStub(JSON.stringify({ tasks: { "11": { id: 11, label: taskLabel(root, "orc-1"), group: "orc", path: "/checkout", status: { Running: { start: oldStart } } } } }))
      const line = await Effect.runPromise(
        killHeld(root, "orc-1", taskLabel(root, "orc-1")).pipe(Effect.provide(Layer.merge(BunServices.layer, spawner)))
      )
      expect(line).toBe("killed pueue task 11 for orc-1")
      const after = await Effect.runPromise(Effect.acquireUseRelease(
        openDatabase(root),
        (db) => runById(db, "run-1"),
        (db) => Effect.sync(() => db.close())
      ).pipe(Effect.provide(BunServices.layer)))
      expect(after?.status).toBe("stopped")
      expect(after?.endReason).toBe(stoppedEndReason)
      expect(after?.prLink).toBe("https://github.com/example/orc/pull/7")
    })
  })
})

describe("the beat's stale start", () => {
  test("a started task the runner never picked up closes failed once the start outgrows the queue delay instead of staying started", async () => {
    await withBacklog(async (root) => {
      await startTaskOne(root, ["orc", "runner", "start"], oldStart)
      const report = await Effect.runPromise(runBeat(root, root, quietSources()).pipe(Effect.provide(Layer.merge(BunServices.layer, pueueStub(JSON.stringify({ tasks: {} }))))))
      expect((await run(listTasks(root))).map((task) => task.spec.id + ":" + task.state.kind)).toEqual(["orc-1:closed"])
      expect(report.actions.map((action) => action.kind + ":" + ("task" in action ? action.task : ""))).toEqual(["closed:orc-1"])
      const closed = (await run(listTasks(root))).find((task) => task.spec.id === "orc-1")
      expect(closed?.state.kind === "closed" ? closed.state.closing.outcome + ":" + closed.state.closing.reason : "")
        .toBe("failed:the runner holds no record of this task")
    })
  })
  test("a fresh start the runner cannot see yet stays started instead of closing on the first beat", async () => {
    await withBacklog(async (root) => {
      await startTaskOne(root, ["orc", "runner", "start"], new Date().toISOString())
      const report = await Effect.runPromise(runBeat(root, root, quietSources()).pipe(Effect.provide(Layer.merge(BunServices.layer, pueueStub(JSON.stringify({ tasks: {} }))))))
      expect((await run(listTasks(root))).map((task) => task.spec.id + ":" + task.state.kind)).toEqual(["orc-1:started"])
      expect(report.actions.map((action) => action.kind)).toEqual([])
    })
  })
  test("a close read that keeps failing closes the task failed instead of retrying forever", async () => {
    await withBacklog(async (root) => {
      await startTaskOne(root, ["orc", "runner", "start"], oldStart)
      const report = await Effect.runPromise(runBeat(root, root, quietSources()).pipe(Effect.provide(Layer.merge(BunServices.layer, pueueFailing))))
      expect((await run(listTasks(root))).map((task) => task.spec.id + ":" + task.state.kind)).toEqual(["orc-1:closed"])
      const closed = (await run(listTasks(root))).find((task) => task.spec.id === "orc-1")
      expect(closed?.state.kind === "closed" ? closed.state.closing.outcome + ":" + closed.state.closing.reason : "")
        .toBe("failed:pueue status exited 3: pueue is down")
      expect(report.actions.map((action) => action.kind + ":" + ("task" in action ? action.task : ""))).toEqual(["closed:orc-1"])
    })
  })
  test("a fresh start with a failing close read waits for the next beat instead of closing failed", async () => {
    await withBacklog(async (root) => {
      await startTaskOne(root, ["orc", "runner", "start"], new Date().toISOString())
      const report = await Effect.runPromise(runBeat(root, root, quietSources()).pipe(Effect.provide(Layer.merge(BunServices.layer, pueueFailing))))
      expect((await run(listTasks(root))).map((task) => task.spec.id + ":" + task.state.kind)).toEqual(["orc-1:started"])
      expect(report.actions.map((action) => action.kind + ":" + ("task" in action ? action.task : ""))).toEqual(["close-failed:orc-1"])
    })
  })
  test("an own-log task with no run output closes failed instead of staying started", async () => {
    await withBacklog(async (root) => {
      await startTaskOne(root, ["true"], oldStart)
      const report = await Effect.runPromise(runBeat(root, root, quietSources()).pipe(Effect.provide(Layer.merge(BunServices.layer, pueueStub(JSON.stringify({ tasks: {} }))))))
      expect((await run(listTasks(root))).map((task) => task.spec.id + ":" + task.state.kind)).toEqual(["orc-1:closed"])
      const closed = (await run(listTasks(root))).find((task) => task.spec.id === "orc-1")
      expect(closed?.state.kind === "closed" ? closed.state.closing.outcome + ":" + closed.state.closing.reason : "")
        .toBe("failed:the machine keeps its own log, and the log shows no run output")
      expect(report.actions.map((action) => action.kind + ":" + ("task" in action ? action.task : ""))).toEqual(["closed:orc-1"])
    })
  })
  test("an own-log task with a fresh log keeps its own record instead of closing", async () => {
    await withBacklog(async (root) => {
      await startTaskOne(root, ["true"], oldStart)
      await mkdir(join(root, "logs"), { recursive: true })
      await writeFile(root + "/logs/orc-1.log", "run output\n", { flag: "w" })
      const report = await Effect.runPromise(runBeat(root, root, quietSources()).pipe(Effect.provide(Layer.merge(BunServices.layer, pueueStub(JSON.stringify({ tasks: {} }))))))
      expect((await run(listTasks(root))).map((task) => task.spec.id + ":" + task.state.kind)).toEqual(["orc-1:started"])
      expect(report.actions.map((action) => action.kind + ":" + ("task" in action ? action.task : ""))).toEqual([])
    })
  })
})

describe("a stopped run", () => {
  const failedRun = { id: "run-1", status: "failed" as const, prLink: null, endReason: "the run was stopped", openQuestions: [] }
  test("a stopped run closes its task stopped instead of failed", () => {
    expect(endingFromResult({ task: "orc-1", pueueTask: 11, status: "failed", started: oldStart, ended: oldStart, reason: "orc exited 1", run: { ...failedRun, status: "stopped" as const } }, "ship")).toEqual({
      kind: "close",
      outcome: "stopped",
      reason: "the run was stopped",
      pr: null,
      report: null
    })
  })
  test("a failed run closes with its end reason instead of the bare pueue reason", () => {
    expect(endingFromResult({ task: "orc-1", pueueTask: 11, status: "failed", started: oldStart, ended: oldStart, reason: "orc exited 1", run: failedRun }, "ship")).toEqual({
      kind: "close",
      outcome: "failed",
      reason: "the run was stopped",
      pr: null,
      report: null
    })
  })
  test("a failed run with no end reason keeps the pueue reason instead of closing blank", () => {
    expect(endingFromResult({ task: "orc-1", pueueTask: 11, status: "failed", started: oldStart, ended: oldStart, reason: "orc exited 1", run: { ...failedRun, endReason: null } }, "ship")).toEqual({
      kind: "close",
      outcome: "failed",
      reason: "orc exited 1",
      pr: null,
      report: null
    })
  })
})

describe("the stale close decision", () => {
  const unknownReading = { kind: "read" as const, result: { task: "orc-1", status: "unknown" as const }, ending: null, outputAt: null, asking: null }
  test("an unseen runner record closes the task failed once the start outgrows the queue delay instead of waiting forever", () => {
    expect(staleEndingOf(oldStart, Date.parse("2026-11-07T10:00:00.000Z"), unknownReading)).toEqual({
      kind: "close",
      outcome: "failed",
      reason: "the runner holds no record of this task",
      pr: null,
      report: null
    })
  })
  test("an unseen runner record on a fresh start keeps running instead of closing on the first beat", () => {
    expect(staleEndingOf(new Date().toISOString(), Date.now(), unknownReading)).toBeNull()
  })
  test("an unread close on an old start closes the task failed instead of retrying forever", () => {
    expect(staleEndingOf(oldStart, Date.parse("2026-11-07T10:00:00.000Z"), { kind: "unread", reason: "pueue status exited 3: pueue is down" })).toEqual({
      kind: "close",
      outcome: "failed",
      reason: "pueue status exited 3: pueue is down",
      pr: null,
      report: null
    })
  })
  test("an unread close on a fresh start waits for the next beat instead of closing failed", () => {
    expect(staleEndingOf(new Date().toISOString(), Date.now(), { kind: "unread", reason: "pueue is down" })).toBeNull()
  })
})

describe("the own-log close decision", () => {
  test("a quiet old log closes the task failed instead of staying started", () => {
    expect(ownLogEndingOf(oldStart, oldStart, Date.parse("2026-11-07T10:00:00.000Z"))).toEqual({
      kind: "close",
      outcome: "failed",
      reason: "the machine keeps its own log, and the log shows no run output",
      pr: null,
      report: null
    })
  })
  test("a missing log on an old start closes the task failed instead of staying started", () => {
    expect(ownLogEndingOf(oldStart, null, Date.parse("2026-11-07T10:00:00.000Z"))).toEqual({
      kind: "close",
      outcome: "failed",
      reason: "the machine keeps its own log, and the log shows no run output",
      pr: null,
      report: null
    })
  })
  test("a fresh log keeps the own-log task instead of closing it", () => {
    expect(ownLogEndingOf(oldStart, new Date().toISOString(), Date.now())).toBeNull()
  })
  test("an old log on a fresh start keeps the own-log task instead of closing it", () => {
    expect(ownLogEndingOf(new Date().toISOString(), oldStart, Date.now())).toBeNull()
  })
})

describe("an interrupted run", () => {
  test("marking a run stopped ends its steps and keeps their session files for a resume instead of deleting the run", async () => {
    await withBacklog(async (root) => {
      await Effect.runPromise(Effect.acquireUseRelease(
        openDatabase(root),
        (db) => Effect.gen(function*() {
          insertRun(db, { id: "run-1", project: "/checkout", branch: "orc/orc-1", taskFile: "orc-1.md", status: "running", started: oldStart, prLink: "https://github.com/example/orc/pull/7" })
          yield* recordStep(db, { runId: "run-1", name: "implement", attempt: 1, status: "running", started: oldStart, agentFile: "agent.md", piSessionFile: "sessions/s.jsonl" })
          yield* recordStep(db, { runId: "run-1", name: "checks", attempt: 1, status: "passed", started: oldStart, ended: oldStart, agentFile: "agent.md" })
        }),
        (db) => Effect.sync(() => db.close())
      ).pipe(Effect.provide(BunServices.layer)))
      await Effect.runPromise(Effect.acquireUseRelease(
        openDatabase(root),
        (db) => markRunStopped(db, "run-1", "2026-11-07T10:00:00.000Z", stoppedEndReason),
        (db) => Effect.sync(() => db.close())
      ).pipe(Effect.provide(BunServices.layer)))
      const after = await Effect.runPromise(Effect.acquireUseRelease(
        openDatabase(root),
        (db) => Effect.gen(function*() {
          return { run: yield* runById(db, "run-1"), steps: yield* stepsForRun(db, "run-1") }
        }),
        (db) => Effect.sync(() => db.close())
      ).pipe(Effect.provide(BunServices.layer)))
      expect(after.run?.status).toBe("stopped")
      expect(after.run?.ended).toBe("2026-11-07T10:00:00.000Z")
      expect(after.run?.endReason).toBe(stoppedEndReason)
      expect(after.run?.prLink).toBe("https://github.com/example/orc/pull/7")
      expect(after.steps.map((step) => step.name + ":" + step.status)).toEqual(["implement:failed", "checks:passed"])
      expect(after.steps.find((step) => step.name === "implement")?.piSessionFile).toBe("sessions/s.jsonl")
    })
  })
})
