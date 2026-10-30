import { strict as assert } from "node:assert"
import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { backlogJson, formatBoard } from "../../packages/run/src/dispatch/board"
import type { Project } from "../../packages/run/src/dispatch/config"
import { heldTask, taskLabel } from "../../packages/run/src/dispatch/pueue-status"
import { fileKeyOf, queueFromText, renewTask } from "../../packages/run/src/dispatch/runner"
import { readStdinLabel } from "../../packages/run/src/dispatch/runner-result"
import type { TaskRecord } from "../../packages/run/src/dispatch/task-record"

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

const projects: ReadonlyArray<Project> = [{ name: "orc", checkouts: { mac: "/Users/a/orc", linux: "/home/a/orc" } }]

const newTask = (machine: string | null): TaskRecord => ({ spec: { ...spec, id: "task-1", machine }, state: { kind: "new" } })

const quotaReply = JSON.stringify({ schema: "orc.quota.v1", accounts: [{ name: "main", remainingPercent: 80 }] })

// Answers pueue status and the quota command itself, and runs every other command for real.
const pueueStub = (statusJson: string): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner
    return ChildProcessSpawner.make((command) =>
      ChildProcess.isStandardCommand(command) && command.command === "pueue"
        ? real.spawn(ChildProcess.make("sh", ["-c", "cat <<'J'\n" + statusJson + "\nJ"]))
        : ChildProcess.isStandardCommand(command) && command.command === "orc-quota"
          ? real.spawn(ChildProcess.make("sh", ["-c", "cat <<'J'\n" + quotaReply + "\nJ"]))
          : real.spawn(command)
    )
  }))

describe("the pueue label", () => {
  test("a task-1 label queued by another home is never read as this home's run instead of the newest bare match winning", () => {
    const running = { start: "2026-10-27T10:02:00.000Z" }
    const tasks = {
      "7": { id: 7, label: taskLabel("/homes/a", "task-1"), group: "orc", path: "/homes/a/orc", status: { Running: running } },
      "9": { id: 9, label: taskLabel("/homes/b", "task-1"), group: "orc", path: "/homes/b/orc", status: { Running: running } },
      "11": { id: 11, label: "task-1", group: "orc", path: "/homes/c/orc", status: { Running: running } }
    }
    expect(heldTask(tasks, "/homes/a", "task-1")?.id).toBe(7)
    expect(heldTask(tasks, "/homes/b", "task-1")?.id).toBe(9)
    expect(heldTask(tasks, "/homes/c", "task-1")).toBeNull()
  })
  test("the label names the home that queued it instead of one shared id", () => {
    expect(taskLabel("/homes/a", "task-1")).not.toBe(taskLabel("/homes/b", "task-1"))
  })
  test("the label treats a trailing slash as the same home instead of another queue", () => {
    expect(taskLabel("/homes/a/", "task-1")).toBe(taskLabel("/homes/a", "task-1"))
  })
  test("a scoped file key never names the folder itself instead of a file inside it", () => {
    expect(fileKeyOf("/homes/a", "task-1", "")).toBe("label-")
    expect(fileKeyOf("/homes/a", "task-1", ".")).toBe("label-.")
    expect(fileKeyOf("/homes/a", "task-1", "..")).toBe("label-..")
  })
  test("a queue request with an empty label is refused instead of queueing under no key", async () => {
    await withBacklog(async (root) => {
      await assert.rejects(run(queueFromText(JSON.stringify({ task: "task-9", checkout: "/checkout", provider: "acme", body: "# x\n", tokenFile: "/secrets/main-token", label: "" }), ["orc"], root)))
      expect(await readdir(root)).not.toContain("runner")
    })
  })
  test("a renewal for . keeps the held token instead of removing the runner folder", async () => {
    await withBacklog(async (root) => {
      await run(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(join(root, "runner", "tokens", "task-1"), { recursive: true })
        yield* fs.writeFileString(join(root, "runner", "tokens", "task-1", "token"), "sentinel")
      }))
      const spawner = pueueStub(JSON.stringify({ tasks: {} })).pipe(Layer.provide(BunServices.layer))
      const stdin = Effect.succeed(JSON.stringify({ task: "task-1", token: "tokenB123", expiresAt: "2027-01-01T00:00:00.000Z", label: "." }))
      await assert.rejects(Effect.runPromise(renewTask(stdin, { kind: "here" }, root).pipe(Effect.provide(Layer.merge(BunServices.layer, spawner)))))
      expect(await readdir(join(root, "runner", "tokens", "task-1"))).toContain("token")
    })
  })
  test("a renewal for .. keeps the held token instead of removing the runner folder", async () => {
    await withBacklog(async (root) => {
      await run(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(join(root, "runner", "tokens", "task-1"), { recursive: true })
        yield* fs.writeFileString(join(root, "runner", "tokens", "task-1", "token"), "sentinel")
      }))
      const spawner = pueueStub(JSON.stringify({ tasks: {} })).pipe(Layer.provide(BunServices.layer))
      const stdin = Effect.succeed(JSON.stringify({ task: "task-1", token: "tokenB123", expiresAt: "2027-01-01T00:00:00.000Z", label: ".." }))
      await assert.rejects(Effect.runPromise(renewTask(stdin, { kind: "here" }, root).pipe(Effect.provide(Layer.merge(BunServices.layer, spawner)))))
      expect(await readdir(join(root, "runner", "tokens", "task-1"))).toContain("token")
    })
  })
})

describe("the result label on stdin", () => {
  test("an empty pipe reads the home's own run instead of refusing", async () => {
    expect(await run(readStdinLabel(Effect.succeed("")))).toBeNull()
  })
  test("a label document reads that home's run instead of the reader's", async () => {
    expect(await run(readStdinLabel(Effect.succeed(JSON.stringify({ label: "/homes/a task-1" }))))).toBe("/homes/a task-1")
  })
  test("a pipe holding no document is refused instead of read as a label", async () => {
    await assert.rejects(run(readStdinLabel(Effect.succeed("no json"))))
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
    expect(first).toMatch(/^task-1 orc @mac Fix the thing +orc on mac,linux$/)
  })
})
