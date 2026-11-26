import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Effect, Fiber, FileSystem, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { addTask, claimTask, closeStartedTask, listTasks, type TaskRecord, writeTaken } from "../../../packages/run/src/entities/backlog/index"
import type { PullRequestView } from "../../../packages/run/src/entities/pull-request/index"
import { prEvents } from "../../../packages/run/src/widgets/beat/task-events"

const head = "0".repeat(40)

const mergeBase = "1".repeat(40)

const baseHead = "2".repeat(40)

const pr = "https://github.com/acme/orc/pull/8"

const view: PullRequestView = {
  state: "OPEN",
  headRefOid: head,
  baseRefName: "main",
  statusCheckRollup: [{ name: "test", workflowName: "ci", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-11-18T10:00:00Z" }],
  mergeCommit: null,
  mergedAt: null
}

const spec = { title: "Tidy the docs", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0 as const, created: "2026-11-18T10:00:00Z", body: "# Tidy the docs\n" }

const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-11-18T10:01:00.000Z" }

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const withClosedTask = async (body: (root: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), "orc-merge-interruption-"))
  const root = join(home, "backlog")
  try {
    await mkdir(root)
    await writeFile(join(root, "dispatch.json"), JSON.stringify({ machines: [{ name: "mac", slots: 1, start: ["orc", "runner", "start", "--", "fake-mac"] }], quota: { provider: "acme", command: ["true"], accounts: [{ name: "main", tokenFile: "/x" }] } }))
    await writeFile(join(root, "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { mac: root }, yolo: true }] }))
    await run(addTask(root, spec))
    await run(claimTask(root, "task-1"))
    await run(writeTaken(root, { spec: { ...spec, id: "task-1" }, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-11-18T10:02:00.000Z", log: "/tmp/task.log" } } }))
    await run(closeStartedTask(root, "task-1", "done", "", { pr, report: null }, "2026-11-18T11:00:00.000Z"))
    await body(root)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const runnerDocument = JSON.stringify({
  schema: "orc.runner.v1",
  result: { task: "task-1", status: "succeeded", pueueTask: 3, run: { id: "run-1", status: "succeeded", prLink: pr, endReason: null, openQuestions: [] }, started: "2026-11-18T10:02:00.000Z", ended: "2026-11-18T10:59:00.000Z" }
})

const forge = (update: "accepted" | "conflict", updates: Array<string>): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner
    const reply = (text: string) => real.spawn(ChildProcess.make("sh", ["-c", "cat <<'J'\n" + text + "\nJ"]))
    return ChildProcessSpawner.make((command) => {
      if (!ChildProcess.isStandardCommand(command)) {
        return real.spawn(command)
      }
      if (command.command === "fake-mac") {
        return reply(runnerDocument)
      }
      if (command.command !== "gh") {
        return real.spawn(command)
      }
      const args = command.args.filter((word): word is string => typeof word === "string")
      const text = "gh " + args.join(" ")
      if (args[0] === "pr" && args[1] === "view") {
        return reply(JSON.stringify(view))
      }
      if (text.includes("/pulls/8/files")) {
        return reply(JSON.stringify({ status: "modified", path: "src/example.ts", previous: null, patch: "+example" }))
      }
      if (text.includes("/compare/main...")) {
        return reply(JSON.stringify({ behind_by: 1, base_commit: { sha: baseHead }, merge_base_commit: { sha: mergeBase }, files: [{ filename: "src/example.ts" }] }))
      }
      if (text.includes("/compare/" + mergeBase + "...")) {
        return reply(JSON.stringify([{ filename: "src/example.ts" }]))
      }
      if (text.includes("/update-branch")) {
        updates.push(text)
        return update === "accepted" ? reply("{}") : real.spawn(ChildProcess.make("sh", ["-c", "echo 'merge conflict between base and head' >&2; exit 1"]))
      }
      return real.spawn(command)
    })
  })).pipe(Layer.provide(BunServices.layer))

const beatTimingOutDuring = (root: string, task: TaskRecord, holdsWrite: (path: string) => boolean, layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>) =>
  Effect.runPromise(Effect.gen(function*() {
    const reached = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const fs = yield* FileSystem.FileSystem
    let held = false
    const slowFs = FileSystem.make({
      ...fs,
      writeFile: (path, data, options) => Effect.suspend(() => {
        if (held || !holdsWrite(path)) {
          return fs.writeFile(path, data, options)
        }
        held = true
        return Deferred.succeed(reached, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(fs.writeFile(path, data, options))
        )
      })
    })
    const beat = yield* prEvents(root, task, () => Effect.succeed(view), "2026-11-18T11:10:00.000Z", true, dirname(root)).pipe(
      Effect.provideService(FileSystem.FileSystem, slowFs),
      Effect.forkChild
    )
    yield* Effect.raceFirst(Deferred.await(reached), Fiber.await(beat))
    yield* TestClock.adjust("31 seconds")
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(beat)
    return held
  }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, layer, TestClock.layer()))))

const grabsLeft = async (root: string): Promise<ReadonlyArray<string>> =>
  (await Promise.all(["new", "taken", "closed"].map(async (folder) => (await readdir(join(root, folder)).catch(() => [])).filter((name) => name.includes(".grab-"))))).flat()

const listed = async (root: string): Promise<ReadonlyArray<TaskRecord>> =>
  (await run(listTasks(root))).filter((candidate) => candidate.spec.id === "task-1")

const onlyTask = async (root: string): Promise<TaskRecord> => {
  const task = (await listed(root)).at(0)
  if (task === undefined) {
    throw new Error("task-1 missing from the backlog")
  }
  return task
}

describe("a beat timeout inside a merge write", () => {
  test("a timeout during the checks-running stage write keeps the updated task in the backlog instead of hiding it", async () => {
    await withClosedTask(async (root) => {
      const updates: Array<string> = []
      const task = await onlyTask(root)
      const held = await beatTimingOutDuring(root, task, (path) => updates.length > 0 && path.startsWith(join(root, "closed") + "/.task-1."), forge("accepted", updates))
      expect(held).toBe(true)
      expect(updates).toHaveLength(1)
      expect(await grabsLeft(root)).toEqual([])
      expect(await listed(root)).toHaveLength(1)
      const settled = await onlyTask(root)
      expect(settled.state.kind).toBe("closed")
      expect(["updating", "checks-running"].includes(settled.merge?.stage ?? "none")).toBe(true)
      expect(settled.merge?.head).toBe(head)
      expect(JSON.parse(await readFile(join(root, "logs", "task-1.merge"), "utf8"))).toMatchObject({ url: pr, head })
    })
  })

  test("a timeout during the send-back publish leaves the task sent back or closed instead of missing", async () => {
    await withClosedTask(async (root) => {
      const updates: Array<string> = []
      const task = await onlyTask(root)
      const held = await beatTimingOutDuring(root, task, (path) => path.startsWith(join(root, "new") + "/.task-1.md."), forge("conflict", updates))
      expect(held).toBe(true)
      expect(updates).toHaveLength(1)
      expect(await grabsLeft(root)).toEqual([])
      expect(await listed(root)).toHaveLength(1)
      const settled = await onlyTask(root)
      const sentBack = settled.state.kind === "new" && settled.parked?.questions.at(0)?.id === "send-back" && settled.parked.origin?.run === "run-1"
      expect(sentBack || settled.state.kind === "closed").toBe(true)
    })
  })
})
