import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { addTask, claimTask, closeStartedTask, listTasks, writeTaken } from "../../../packages/run/src/entities/backlog/index"
import { runBeat } from "../../../packages/run/src/widgets/beat/beat"
import { formatBeat } from "../../../packages/run/src/widgets/beat/board"
import { parentLabel, taskLabel } from "../../../packages/run/src/shared/process/pueue-status"
import { killHeld, startTask } from "../../../packages/run/src/features/queueing-a-task/index"
import { resolveTaskFile } from "../../../packages/run/src/features/running-a-task/run-resume"
import { runsForBranch } from "../../../packages/run/src/entities/run-history/index"
import { insertRun, insertStep, openDatabase, stoppedEndReason } from "../../../packages/run/src/entities/run-history/index"
import { quietSources } from "../../lib/beat-sources"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const spec = { title: "Ship task splitting", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], created: "2026-11-11T10:00:00.000Z", body: "# Ship task splitting\n" }
const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-11-11T10:01:00.000Z" }
const started = { at: "2026-11-11T10:02:00.000Z", log: "/logs/orc-1.log" }
const quota = { provider: "keyed", command: ["orc-quota"], accounts: [{ name: "main", kind: "token-file", tokenFile: "/secrets/main-token" }], floorPercent: 15 } as const
const quotaReply = JSON.stringify({ schema: "orc.quota.v1", accounts: [{ name: "main", remainingPercent: 80 }] })

const proposal = {
  schema: "orc.split.v1",
  plan: "split",
  reason: "it touches the record and the listing",
  done: ["a big change lands as linked children"],
  children: [
    { title: "Record the split", body: "Add the split mark.", after: [] },
    { title: "Show the plan", body: "List the children.", after: [1] }
  ]
}

const pueueWith = (statusJson: string): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner
    const reply = (text: string) => real.spawn(ChildProcess.make("sh", ["-c", "cat <<'J'\n" + text + "\nJ"]))
    return ChildProcessSpawner.make((command) =>
      ChildProcess.isStandardCommand(command) && command.command === "pueue"
        ? reply(statusJson)
        : ChildProcess.isStandardCommand(command) && command.command === "orc-quota" ? reply(quotaReply) : real.spawn(command)
    )
  })).pipe(Layer.provide(BunServices.layer))

const pueueFailed = (root: string, task = "orc-1"): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
  pueueWith(JSON.stringify({ tasks: { "11": { id: 11, label: taskLabel(root, task), group: "orc", path: "/checkout", status: { Done: { start: started.at, end: "2026-11-11T10:05:00.000Z", result: { Failed: 1 } } } } } }))

const beatAfterRun = async (endReason: string, body: (root: string, lines: ReadonlyArray<string>) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-run-split-"))
  try {
    await writeFile(join(root, "dispatch.json"), JSON.stringify({ machines: [{ name: "mac", slots: 4, start: ["sh", "-c", "true", "runner", "start"] }], quota }))
    await writeFile(join(root, "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { mac: "/checkout" } }] }))
    await run(addTask(root, spec))
    await run(claimTask(root, "orc-1"))
    await run(writeTaken(root, { spec: { ...spec, id: "orc-1" }, hold: null, parked: null, state: { kind: "started", claim, started } }))
    const workerTaskFile = join(root, "run-1-task.md")
    await writeFile(workerTaskFile, spec.body)
    await run(Effect.acquireUseRelease(
      openDatabase(root),
      (db) => Effect.sync(() => {
        insertRun(db, { id: "run-1", project: "/checkout", branch: "orc/orc-1", taskFile: workerTaskFile, status: "failed", started: started.at, prLink: null, endReason })
        insertStep(db, { runId: "run-1", name: "implement", attempt: 1, status: "failed", started: started.at, ended: "2026-11-11T10:04:00.000Z" })
      }),
      (db) => Effect.sync(() => db.close())
    ))
    const report = await Effect.runPromise(runBeat(root, root, quietSources()).pipe(Effect.provide(Layer.merge(BunServices.layer, pueueFailed(root)))))
    await body(root, formatBeat(report).split("\n"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const closeChildrenAndStartParent = async (root: string): Promise<ReadonlyArray<string>> => {
  await run(closeStartedTask(root, "orc-2", "done", "child done", { pr: null, report: null }, "2026-11-11T10:06:00.000Z"))
  await run(claimTask(root, "orc-3"))
  const orc3 = (await run(listTasks(root))).find((task) => task.spec.id === "orc-3")
  if (orc3 === undefined) {
    throw new Error("orc-3 is missing after the split")
  }
  await run(writeTaken(root, { ...orc3, state: { kind: "started", claim, started } }))
  await run(closeStartedTask(root, "orc-3", "done", "child done", { pr: null, report: null }, "2026-11-11T10:07:00.000Z"))
  const second = await Effect.runPromise(runBeat(root, root, quietSources()).pipe(Effect.provide(Layer.merge(BunServices.layer, pueueFailed(root)))))
  return formatBeat(second).split("\n")
}

const beatAfterChildSplit = async (body: (root: string, lines: ReadonlyArray<string>) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-run-split-"))
  try {
    await writeFile(join(root, "dispatch.json"), JSON.stringify({ machines: [{ name: "mac", slots: 4, start: ["sh", "-c", "true", "runner", "start"] }], quota }))
    await writeFile(join(root, "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { mac: "/checkout" } }] }))
    const grandparent = { title: "Big feature", project: "orc", kind: "parent" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], created: "2026-11-11T10:00:00.000Z", body: "# Big feature\n" }
    const child = { title: "Second slice", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: "orc-1", split: null, dependsOn: [], created: "2026-11-11T10:00:00.000Z", body: "# Second slice\n" }
    await run(addTask(root, grandparent))
    await run(addTask(root, child))
    await run(addTask(root, { ...child, title: "Third slice", body: "# Third slice\n", dependsOn: ["orc-2"] }))
    await run(claimTask(root, "orc-2"))
    await run(writeTaken(root, { spec: { ...child, id: "orc-2" }, hold: null, parked: null, state: { kind: "started", claim, started } }))
    const workerTaskFile = join(root, "run-2-task.md")
    await writeFile(workerTaskFile, child.body)
    await run(Effect.acquireUseRelease(
      openDatabase(root),
      (db) => Effect.sync(() => {
        insertRun(db, { id: "run-2", project: "/checkout", branch: "orc/orc-2", taskFile: workerTaskFile, status: "failed", started: started.at, prLink: null, endReason: "split proposal: " + JSON.stringify(proposal) })
        insertStep(db, { runId: "run-2", name: "implement", attempt: 1, status: "failed", started: started.at, ended: "2026-11-11T10:04:00.000Z" })
      }),
      (db) => Effect.sync(() => db.close())
    ))
    const report = await Effect.runPromise(runBeat(root, root, quietSources()).pipe(Effect.provide(Layer.merge(BunServices.layer, pueueFailed(root, "orc-2")))))
    await body(root, formatBeat(report).split("\n"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("the beat applying a worker's split proposal", () => {
  test("a valid proposal turns the task into a parent and starts its free child instead of closing the task failed", async () => {
    await beatAfterRun("split proposal: " + JSON.stringify(proposal), async (root, lines) => {
      const tasks = await run(listTasks(root))
      const parent = tasks.find((task) => task.spec.id === "orc-1")
      expect(parent?.spec.kind).toBe("parent")
      expect(parent?.state.kind).toBe("new")
      expect(parent?.spec.split).toEqual({ by: "run", reason: proposal.reason })
      expect(parent?.spec.body).toBe("# Ship task splitting\n\n## Done when\n\n- a big change lands as linked children\n")
      const children = tasks.filter((task) => task.spec.parent === "orc-1")
      expect(children.map((child) => [child.spec.id, child.spec.kind, child.spec.title, child.spec.dependsOn, child.state.kind])).toEqual([
        ["orc-2", "ship", "Record the split", [], "started"],
        ["orc-3", "ship", "Show the plan", ["orc-2"], "new"]
      ])
      expect(lines).toContain("split orc-1 on mac into orc-2, orc-3: " + proposal.reason)
      expect(lines.some((line) => line.startsWith("closed orc-1"))).toBe(false)
      const event = await readFile(join(root, "events", "orc-1.split.json"), "utf8")
      expect(JSON.parse(event)).toMatchObject({ text: "orc-1 Ship task splitting split at run into orc-2 Record the split, orc-3 Show the plan: " + proposal.reason })
    })
  })

  test("a run-split parent starts its final check on its own branch with no prior run", async () => {
    await beatAfterRun("split proposal: " + JSON.stringify(proposal), async (root) => {
      const lines = await closeChildrenAndStartParent(root)
      expect(lines.some((line) => line.startsWith("started orc-1 on mac"))).toBe(true)
      const parent = (await run(listTasks(root))).find((task) => task.spec.id === "orc-1")
      expect(parent?.state.kind).toBe("started")
      const captured = join(root, "forwarded.json")
      await Effect.runPromise(startTask({ ORC_TASK_ID: "orc-1", ORC_TASK_FILE: join(root, "taken", "orc-1.md"), ORC_TASK_CHECKOUT: "/checkout", ORC_TASK_PROVIDER: "test" }, Effect.succeed(""), { kind: "through", command: ["sh", "-c", "cat > " + captured] as const }, ["orc"] as const, root).pipe(Effect.provide(BunServices.layer)))
      const forwarded = Schema.decodeUnknownSync(Schema.Struct({ branch: Schema.optional(Schema.String) }))(JSON.parse(await readFile(captured, "utf8")))
      const parentPath = join(root, "parent.md")
      await writeFile(parentPath, parent?.spec.body ?? "")
      await run(Effect.acquireUseRelease(
        openDatabase(root),
        (db) => Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          expect(yield* resolveTaskFile(db, fs, forwarded.branch ?? "", "/checkout", parentPath)).toBe(parentPath)
          const refused = yield* resolveTaskFile(db, fs, "orc/orc-1", "/checkout", parentPath).pipe(Effect.flip)
          expect(refused.message).toContain("recorded progress")
        }),
        (db) => Effect.sync(() => db.close())
      ))
      expect(forwarded.branch).toBe("orc/orc-1-parent")
    })
  })

  test("an invalid proposal closes the task failed instead of creating children", async () => {
    const reason = "invalid split proposal: printed no orc.split.v1 document"
    await beatAfterRun(reason, async (root, lines) => {
      const tasks = await run(listTasks(root))
      expect(tasks.map((task) => [task.spec.id, task.spec.kind, task.state.kind])).toEqual([["orc-1", "ship", "closed"]])
      expect(lines).toContain("closed orc-1 failed on mac: " + reason)
    })
  })

  test("a split from a child gives its parent the slices as children instead of nesting a parent", async () => {
    await beatAfterChildSplit(async (root, lines) => {
      const tasks = await run(listTasks(root))
      expect(tasks.filter((task) => task.spec.parent === "orc-1").map((task) => [task.spec.id, task.spec.kind, task.spec.title])).toEqual([
        ["orc-3", "ship", "Third slice"],
        ["orc-4", "ship", "Record the split"],
        ["orc-5", "ship", "Show the plan"]
      ])
      const parents = new Set(tasks.filter((task) => task.spec.kind === "parent").map((task) => task.spec.id))
      expect(tasks.filter((task) => task.spec.parent !== null && parents.has(task.spec.id))).toEqual([])
      const proposer = tasks.find((task) => task.spec.id === "orc-2")
      expect(proposer?.spec.kind).toBe("ship")
      expect(proposer?.state.kind === "closed" ? proposer.state.closing.outcome + ":" + proposer.state.closing.reason : "")
        .toBe("done:split into orc-4, orc-5: " + proposal.reason)
      expect(tasks.find((task) => task.spec.id === "orc-4")?.spec.body).toContain("This is one slice of orc-1, Big feature")
      expect(lines).toContain("split orc-2 on mac into orc-4, orc-5: " + proposal.reason)
      const event = await readFile(join(root, "events", "orc-2.split.json"), "utf8")
      expect(JSON.parse(event)).toMatchObject({ text: "orc-2 Second slice split at run into orc-4 Record the split, orc-5 Show the plan: " + proposal.reason })
    })
  })

  test("a child split keeps its done criteria on the parent instead of dropping them", async () => {
    await beatAfterChildSplit(async (root) => {
      const parent = (await run(listTasks(root))).find((task) => task.spec.id === "orc-1")
      expect(parent?.spec.body).toContain("## Done when")
      expect(parent?.spec.body).toContain("- from orc-2 split: " + proposal.done[0])
    })
  })

  test("a task waiting on a child that splits waits on the slices instead of starting at once", async () => {
    await beatAfterChildSplit(async (root) => {
      const waiter = (await run(listTasks(root))).find((task) => task.spec.id === "orc-3")
      expect(waiter?.state.kind).toBe("new")
      expect(waiter?.spec.dependsOn).toEqual(["orc-4", "orc-5"])
    })
  })

  test("killing a parent with an earlier worker run closes stopped instead of closing failed on the stale run", async () => {
    await beatAfterRun("split proposal: " + JSON.stringify(proposal), async (root) => {
      await closeChildrenAndStartParent(root)
      const killStatus = JSON.stringify({ tasks: {
        "11": { id: 11, label: taskLabel(root, "orc-1"), group: "orc", path: "/checkout", status: { Done: { start: started.at, end: "2026-11-11T10:05:00.000Z", result: { Failed: 1 } } } },
        "12": { id: 12, label: parentLabel(root, "orc-1"), group: "orc", path: "/checkout", status: { Queued: {} } }
      } })
      const killLine = await Effect.runPromise(
        killHeld(root, "orc-1", parentLabel(root, "orc-1")).pipe(Effect.provide(Layer.merge(BunServices.layer, pueueWith(killStatus))))
      )
      expect(killLine).toBe("killed pueue task 12 for orc-1")
      const stopped = await run(Effect.acquireUseRelease(
        openDatabase(root),
        (db) => runsForBranch(db, "/checkout", "orc/orc-1-parent"),
        (db) => Effect.sync(() => db.close())
      ).pipe(Effect.provide(BunServices.layer)))
      expect(stopped.map((entry) => entry.status)).toEqual(["stopped"])
      const report = await Effect.runPromise(runBeat(root, root, quietSources()).pipe(Effect.provide(Layer.merge(BunServices.layer, pueueFailed(root)))))
      const closed = (await run(listTasks(root))).find((task) => task.spec.id === "orc-1")
      expect(closed?.state.kind === "closed" ? closed.state.closing.outcome + ":" + closed.state.closing.reason : "").toBe("stopped:" + stoppedEndReason)
      expect(formatBeat(report).split("\n")).toContain("closed orc-1 stopped on mac: " + stoppedEndReason)
    })
  })
})
