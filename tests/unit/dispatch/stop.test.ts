import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Path } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { parseDispatchArgs } from "../../../packages/run/src/dispatch/args"
import { runDispatch, type DispatchPlace } from "../../../packages/run/src/dispatch/cli"
import { addTask, claimTask, closeStartedTask, listTasks, writeTaken, renderTaskFile } from "../../../packages/run/src/entities/backlog/index"
import { runBeat } from "../../../packages/run/src/dispatch/beat"
import { taskLabel } from "../../../packages/run/src/shared/process/pueue-status"
import { killHeld } from "../../../packages/run/src/dispatch/runner"
import { formatResult } from "../../../packages/run/src/dispatch/runner-result"
import { markRunStopped } from "../../../packages/run/src/run-history"
import { buildResumePlan } from "../../../packages/run/src/run-resume"
import type { AgentFile } from "../../../packages/run/src/agents"
import type { HistoryRun } from "../../../packages/run/src/run-record"
import { subprocessNoMistakesRunner } from "../../../packages/run/src/no-mistakes"
import { insertRun, openDatabase, recordStep, runById, stoppedEndReason } from "../../../packages/run/src/run-history"
import { runsForBranch, stepsForRun } from "../../../packages/run/src/history-resume"
import type { DispatchConfig, Project } from "../../../packages/run/src/shared/config/dispatch-config"
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

const spec = { title: "Fix the thing", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], created: "2026-10-27T10:00:00.000Z", body: "# Fix the thing\n" }

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

describe("backlog stop", () => {
  test("backlog stop closes the killed run stopped with its PR instead of a bare captain close", async () => {
    await withBacklog(async (root) => {
      const backlog = join(root, "backlog")
      await mkdir(backlog, { recursive: true })
      await writeFile(join(backlog, "dispatch.json"), JSON.stringify({ ...config, machines: [{ name: "mac", slots: 1, start: ["orc", "runner", "start"] }] }))
      await writeFile(join(backlog, "projects.json"), JSON.stringify({ projects }))
      await run(addTask(backlog, spec))
      await run(claimTask(backlog, "orc-1"))
      const first = (await run(listTasks(backlog))).find((task) => task.spec.id === "orc-1")
      if (first === undefined) {
        throw new Error("the backlog holds no orc-1")
      }
      await run(writeTaken(backlog, { spec: first.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: oldStart, log: backlog + "/logs/orc-1.log" } } }))
      await Effect.runPromise(Effect.acquireUseRelease(
        openDatabase(root),
        (db) => Effect.gen(function*() {
          insertRun(db, { id: "run-1", project: "/checkout", branch: "orc/orc-1", taskFile: "orc-1.md", status: "running", started: oldStart, prLink: "https://github.com/example/orc/pull/7" })
          yield* recordStep(db, { runId: "run-1", name: "implement", attempt: 1, status: "running", started: oldStart, agentFile: "agent.md", piSessionFile: null })
        }),
        (db) => Effect.sync(() => db.close())
      ).pipe(Effect.provide(BunServices.layer)))
      const spawner = pueueStub(JSON.stringify({ tasks: { "11": { id: 11, label: taskLabel(root, "orc-1"), group: "orc", path: "/checkout", status: { Running: { start: oldStart } } } } }))
      const place: DispatchPlace = { home: root, cwd: root, env: {}, self: ["orc"] as const, stdin: Effect.succeed(""), stdinIsTerminal: true, stdoutIsTerminal: false }
      await Effect.runPromise(
        runDispatch({ kind: "StopTask", id: "orc-1" }, place).pipe(Effect.provide(Layer.merge(BunServices.layer, spawner)))
      )
      const closed = (await run(listTasks(backlog))).find((task) => task.spec.id === "orc-1")
      if (closed?.state.kind !== "closed") {
        throw new Error("orc-1 never closed")
      }
      expect(closed.state.closing.outcome).toBe("stopped")
      expect(closed.state.closing.reason).toBe(stoppedEndReason)
      expect(closed.state.closing.outcome === "start-failed" ? null : closed.state.closing.pr).toBe("https://github.com/example/orc/pull/7")
    })
  })
})

describe("backlog stop on an own-log machine", () => {
  test("backlog stop refuses an unreachable machine instead of killing this host's pueue", async () => {
    await withBacklog(async (root) => {
      const backlog = join(root, "backlog")
      await mkdir(backlog, { recursive: true })
      await writeFile(join(backlog, "dispatch.json"), JSON.stringify({ ...config, machines: [{ name: "box", slots: 1, start: ["ssh", "box", "run-thing"] }] }))
      await writeFile(join(backlog, "projects.json"), JSON.stringify({ projects }))
      await run(addTask(backlog, spec))
      await run(claimTask(backlog, "orc-1"))
      const first = (await run(listTasks(backlog))).find((task) => task.spec.id === "orc-1")
      if (first === undefined) {
        throw new Error("the backlog holds no orc-1")
      }
      await run(writeTaken(backlog, { spec: first.spec, hold: null, parked: null, state: { kind: "started", claim: { ...claim, machine: "box" }, started: { at: oldStart, log: backlog + "/logs/orc-1.log" } } }))
      const place: DispatchPlace = { home: root, cwd: root, env: {}, self: ["orc"] as const, stdin: Effect.succeed(""), stdinIsTerminal: true, stdoutIsTerminal: false }
      const failure = await Effect.runPromise(
        Effect.flip(runDispatch({ kind: "StopTask", id: "orc-1" }, place)).pipe(Effect.provide(BunServices.layer))
      )
      expect(failure).toBe("orc-1 started on box, which orc cannot reach, so close it by hand with orc backlog close orc-1 failed")
      expect((await run(listTasks(backlog))).map((task) => task.spec.id + ":" + task.state.kind)).toEqual(["orc-1:started"])
    })
  })
})

describe("a stopped close keeps the run PR", () => {
  test("runner result text names the stopped run instead of hiding it", () => {
    expect(formatResult({ task: "orc-1", status: "unknown" })).toBe("orc-1: no pueue task in group orc holds it")
    expect(formatResult({
      task: "orc-1",
      status: "unknown",
      run: { id: "run-1", status: "stopped", prLink: "https://github.com/example/orc/pull/7", endReason: "the run was stopped", openQuestions: [] }
    })).toBe("orc-1: no pueue task in group orc holds it\norc run run-1 stopped, PR https://github.com/example/orc/pull/7: the run was stopped")
  })
})

describe("the unread marker", () => {
  test("closing a task removes its unread marker instead of leaving it in logs", async () => {
    await withBacklog(async (root) => {
      await startTaskOne(root, ["orc", "runner", "start"], oldStart)
      await mkdir(join(root, "logs"), { recursive: true })
      await writeFile(join(root, "logs", "orc-1.unread"), oldStart)
      await run(closeStartedTask(root, "orc-1", "failed", "the runner holds no record of this task", { pr: null, report: null }, "2026-11-07T10:00:00.000Z"))
      const gone = await Effect.runPromise(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        return !(yield* fs.exists(join(root, "logs", "orc-1.unread")))
      }).pipe(Effect.provide(BunServices.layer)))
      expect(gone).toBe(true)
    })
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
  test("kill on a queued pueue task leaves a stopped run instead of no record", async () => {
    await withBacklog(async (root) => {
      const spawner = pueueKillRefusing(JSON.stringify({ tasks: { "11": { id: 11, label: taskLabel(root, "orc-1"), group: "orc", path: "/checkout", status: { Queued: {} } } } }))
      await Effect.runPromise(
        killHeld(root, "orc-1", taskLabel(root, "orc-1")).pipe(Effect.provide(Layer.merge(BunServices.layer, spawner)))
      )
      const runs = await Effect.runPromise(Effect.acquireUseRelease(
        openDatabase(root),
        (db) => runsForBranch(db, "/checkout", "orc/orc-1"),
        (db) => Effect.sync(() => db.close())
      ).pipe(Effect.provide(BunServices.layer)))
      expect(runs.map((entry) => entry.status)).toEqual(["stopped"])
      expect(runs.map((entry) => entry.endReason)).toEqual([stoppedEndReason])
    })
  })
  test("kill on a queued restart records a stopped run instead of closing the old failed run again", async () => {
    await withBacklog(async (root) => {
      await Effect.runPromise(Effect.acquireUseRelease(
        openDatabase(root),
        (db) => Effect.gen(function*() {
          insertRun(db, { id: "run-0", project: "/checkout", branch: "orc/orc-1", taskFile: "orc-1.md", status: "failed", started: oldStart, ended: "2026-10-27T10:05:00.000Z", endReason: "orc exited 1" })
          yield* recordStep(db, { runId: "run-0", name: "implement", attempt: 1, status: "running", started: oldStart, agentFile: "agent.md", piSessionFile: null })
        }),
        (db) => Effect.sync(() => db.close())
      ).pipe(Effect.provide(BunServices.layer)))
      const spawner = pueueKillRefusing(JSON.stringify({ tasks: { "11": { id: 11, label: taskLabel(root, "orc-1"), group: "orc", path: "/checkout", status: { Queued: {} } } } }))
      const line = await Effect.runPromise(
        killHeld(root, "orc-1", taskLabel(root, "orc-1")).pipe(Effect.provide(Layer.merge(BunServices.layer, spawner)))
      )
      expect(line).toBe("removed pueue task 11 for orc-1")
      const runs = await Effect.runPromise(Effect.acquireUseRelease(
        openDatabase(root),
        (db) => runsForBranch(db, "/checkout", "orc/orc-1"),
        (db) => Effect.sync(() => db.close())
      ).pipe(Effect.provide(BunServices.layer)))
      expect(runs.map((entry) => entry.status)).toEqual(["stopped", "failed"])
      expect(runs[0]?.endReason).toBe(stoppedEndReason)
      const liveId = "aaa111"
      await mkdir(join(root, "runs", "run-0", "session", "agent", "sessions", "enc"), { recursive: true })
      await writeFile(join(root, "runs", "run-0", "session", "agent", "sessions", "enc", "2026-11-07T09-30-00-000Z_" + liveId + ".jsonl"), JSON.stringify({ type: "session", id: liveId }) + "\n")
      const agent: AgentFile = { kind: "implementer", model: "opencode-go/muse-spark", thinking: "high", tools: ["read"], body: "Do the task.", path: "bundled/implementer.md", source: "bundled" }
      const next = await Effect.runPromise(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const childSpawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const runDir = path.join(root, "runs", "run-9")
        const history: HistoryRun = {
          fs, path, spawner: childSpawner, git: "git", projectDir: "/checkout", runId: "run-9", runDir,
          piSessionDir: path.join(runDir, "session"),
          hostSessionsDir: path.join(runDir, "sessions"),
          taskPath: path.join(runDir, "task.md"),
          instructions: null, agent, fixer: { ...agent, kind: "fixer", body: "Fix the failure.", path: "bundled/fixer.md" }, branch: "orc/orc-1", sandbox: "nono",
          started: "2026-11-07T10:00:00.000Z", worktreeDir: "/checkout",
          delivery: { kind: "no-mistakes", runner: subprocessNoMistakesRunner({ spawner: childSpawner, binary: "no-mistakes", pathEnv: "", git: "git", worktreeDir: "/checkout" }) },
          allow: [], answers: []
        }
        return history
      }).pipe(Effect.provide(BunServices.layer)))
      const plan = await Effect.runPromise(Effect.acquireUseRelease(
        openDatabase(root),
        (db) => buildResumePlan(db, next),
        (db) => Effect.sync(() => db.close())
      ).pipe(Effect.provide(BunServices.layer)))
      expect(plan.implementSessionId).toBe(liveId)
      expect(plan.skipImplement).toBe(false)
    })
  })
  test("kill on a running task with no run row starts the stopped run inside the pueue interval instead of after it", async () => {
    await withBacklog(async (root) => {
      const spawner = pueueStub(JSON.stringify({ tasks: { "11": { id: 11, label: taskLabel(root, "orc-1"), group: "orc", path: "/checkout", status: { Running: { start: oldStart } } } } }))
      await Effect.runPromise(
        killHeld(root, "orc-1", taskLabel(root, "orc-1")).pipe(Effect.provide(Layer.merge(BunServices.layer, spawner)))
      )
      const runs = await Effect.runPromise(Effect.acquireUseRelease(
        openDatabase(root),
        (db) => runsForBranch(db, "/checkout", "orc/orc-1"),
        (db) => Effect.sync(() => db.close())
      ).pipe(Effect.provide(BunServices.layer)))
      expect(runs.map((entry) => entry.status)).toEqual(["stopped"])
      expect(runs.map((entry) => entry.started)).toEqual([oldStart])
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
      expect(report.actions.map((action) => action.kind + ":" + ("task" in action ? action.task : ""))).toEqual(["closed:orc-1", "attention:orc-1"])
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
  test("a close read that keeps failing closes the task failed once unread past the grace instead of retrying forever", async () => {
    await withBacklog(async (root) => {
      await startTaskOne(root, ["orc", "runner", "start"], oldStart)
      const first = await Effect.runPromise(runBeat(root, root, quietSources()).pipe(Effect.provide(Layer.merge(BunServices.layer, pueueFailing))))
      expect((await run(listTasks(root))).map((task) => task.spec.id + ":" + task.state.kind)).toEqual(["orc-1:started"])
      expect(first.actions.map((action) => action.kind + ":" + ("task" in action ? action.task : ""))).toEqual(["close-failed:orc-1"])
      await mkdir(join(root, "logs"), { recursive: true })
      await writeFile(join(root, "logs", "orc-1.unread"), oldStart)
      const report = await Effect.runPromise(runBeat(root, root, quietSources()).pipe(Effect.provide(Layer.merge(BunServices.layer, pueueFailing))))
      expect((await run(listTasks(root))).map((task) => task.spec.id + ":" + task.state.kind)).toEqual(["orc-1:closed"])
      const closed = (await run(listTasks(root))).find((task) => task.spec.id === "orc-1")
      expect(closed?.state.kind === "closed" ? closed.state.closing.outcome + ":" + closed.state.closing.reason : "")
        .toBe("failed:pueue status exited 3: pueue is down")
      expect(report.actions.map((action) => action.kind + ":" + ("task" in action ? action.task : ""))).toEqual(["closed:orc-1", "attention:orc-1"])
      const markerGone = await Effect.runPromise(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        return !(yield* fs.exists(join(root, "logs", "orc-1.unread")))
      }).pipe(Effect.provide(BunServices.layer)))
      expect(markerGone).toBe(true)
    })
  })
  test("an unseen runner record with a stopped run closes stopped instead of failed", async () => {
    await withBacklog(async (root) => {
      await startTaskOne(root, ["orc", "runner", "start"], oldStart)
      await Effect.runPromise(Effect.acquireUseRelease(
        openDatabase(root),
        (db) => Effect.sync(() => insertRun(db, { id: "run-1", project: "/checkout", branch: "orc/orc-1", taskFile: "orc-1.md", status: "stopped", started: oldStart, ended: oldStart, prLink: "https://github.com/example/orc/pull/7", endReason: "the run was stopped" })),
        (db) => Effect.sync(() => db.close())
      ).pipe(Effect.provide(BunServices.layer)))
      const report = await Effect.runPromise(runBeat(root, root, quietSources()).pipe(Effect.provide(Layer.merge(BunServices.layer, pueueStub(JSON.stringify({ tasks: {} }))))))
      expect((await run(listTasks(root))).map((task) => task.spec.id + ":" + task.state.kind)).toEqual(["orc-1:closed"])
      const closed = (await run(listTasks(root))).find((task) => task.spec.id === "orc-1")
      expect(closed?.state.kind === "closed" ? closed.state.closing.outcome + ":" + closed.state.closing.reason : "")
        .toBe("stopped:the run was stopped")
      expect(closed?.state.kind === "closed" && closed.state.closing.outcome !== "start-failed" ? closed.state.closing.pr : null).toBe("https://github.com/example/orc/pull/7")
      expect(closed === undefined ? "" : renderTaskFile(closed)).toContain("pr: \"https://github.com/example/orc/pull/7\"")
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
        .toBe("failed:the machine keeps its own log, and its log has not grown for 30 minutes")
      expect(report.actions.map((action) => action.kind + ":" + ("task" in action ? action.task : ""))).toEqual(["closed:orc-1", "attention:orc-1"])
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


describe("an interrupted run", () => {
  const agent: AgentFile = {
    kind: "implementer",
    model: "opencode-go/muse-spark",
    thinking: "high",
    tools: ["read"],
    body: "Do the task.",
    path: "bundled/implementer.md",
    source: "bundled"
  }
  const fixer: AgentFile = { ...agent, kind: "fixer", body: "Fix the failure.", path: "bundled/fixer.md" }
  test("marking a run stopped keeps its running steps and finds their live session for a resume instead of ending the steps", async () => {
    await withBacklog(async (root) => {
      await Effect.runPromise(Effect.acquireUseRelease(
        openDatabase(root),
        (db) => Effect.gen(function*() {
          insertRun(db, { id: "run-1", project: "/checkout", branch: "orc/orc-1", taskFile: "orc-1.md", status: "running", started: oldStart, prLink: "https://github.com/example/orc/pull/7" })
          yield* recordStep(db, { runId: "run-1", name: "implement", attempt: 1, status: "running", started: oldStart, agentFile: "agent.md", piSessionFile: null })
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
      expect(after.steps.map((step) => step.name + ":" + step.status)).toEqual(["implement:running", "checks:passed"])
      const liveId = "aaa111"
      await mkdir(join(root, "runs", "run-1", "session", "agent", "sessions", "enc"), { recursive: true })
      await writeFile(join(root, "runs", "run-1", "session", "agent", "sessions", "enc", "2026-11-07T09-30-00-000Z_" + liveId + ".jsonl"), JSON.stringify({ type: "session", id: liveId }) + "\n")
      const next = await Effect.runPromise(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const runDir = path.join(root, "runs", "run-2")
        const history: HistoryRun = {
          fs, path, spawner, git: "git", projectDir: "/checkout", runId: "run-2", runDir,
          piSessionDir: path.join(runDir, "session"),
          hostSessionsDir: path.join(runDir, "sessions"),
          taskPath: path.join(runDir, "task.md"),
          instructions: null, agent, fixer, branch: "orc/orc-1", sandbox: "nono",
          started: "2026-11-07T10:00:00.000Z", worktreeDir: "/checkout",
          delivery: { kind: "no-mistakes", runner: subprocessNoMistakesRunner({ spawner, binary: "no-mistakes", pathEnv: "", git: "git", worktreeDir: "/checkout" }) },
          allow: [], answers: []
        }
        return history
      }).pipe(Effect.provide(BunServices.layer)))
      const plan = await Effect.runPromise(Effect.acquireUseRelease(
        openDatabase(root),
        (db) => buildResumePlan(db, next),
        (db) => Effect.sync(() => db.close())
      ).pipe(Effect.provide(BunServices.layer)))
      expect(plan.implementSessionId).toBe(liveId)
      expect(plan.skipImplement).toBe(false)
    })
  })
})
