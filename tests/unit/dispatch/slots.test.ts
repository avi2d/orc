import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { addTask, claimTask } from "../../../packages/run/src/entities/backlog/index"
import { startTask } from "../../../packages/run/src/features/queueing-a-task/index"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const withBacklog = async (body: (root: string, checkout: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-slots-"))
  try {
    const checkout = join(root, "checkout")
    await mkdir(checkout, { recursive: true })
    await body(root, checkout)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const spec = { title: "Fix the thing", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0 as const, created: "2026-11-15T10:00:00.000Z", body: "# Fix the thing\n" }

const writeSlots = (root: string, slots: number): Promise<void> =>
  writeFile(join(root, "dispatch.json"), JSON.stringify({
    machines: [{ name: "winbox", slots, start: ["orc", "runner", "start"] }],
    quota: { provider: "test", command: ["orc-quota"], accounts: [{ name: "main", kind: "none" }] }
  }))

const takeTask = async (root: string): Promise<string> => {
  const { spec: { id } } = await run(addTask(root, spec))
  await run(claimTask(root, id))
  return id
}

const startEnv = (root: string, checkout: string, task: string): Record<string, string> => ({
  ORC_TASK_ID: task,
  ORC_TASK_FILE: join(root, "taken", task + ".md"),
  ORC_TASK_CHECKOUT: checkout,
  ORC_TASK_PROVIDER: "test",
  ORC_TASK_MACHINE: "winbox"
})

const recordingPueue = (calls: Array<ReadonlyArray<string>>): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner
    return ChildProcessSpawner.make((command) => {
      if (ChildProcess.isStandardCommand(command) && command.command === "pueue") {
        calls.push(command.args.map(String))
        const verb = command.args[0] ?? ""
        return real.spawn(ChildProcess.make("sh", ["-c", verb === "group" ? "echo '{\"orc\":{}}'" : verb === "status" ? "echo '{\"tasks\":{}}'" : verb === "parallel" ? "true" : "echo 77"]))
      }
      return real.spawn(command)
    })
  })).pipe(Layer.provide(BunServices.layer))

const startHere = (root: string, checkout: string, task: string, calls: Array<ReadonlyArray<string>>): Promise<string | null> =>
  Effect.runPromise(
    startTask(startEnv(root, checkout, task), Effect.succeed(""), { kind: "here" }, ["orc"] as const, root).pipe(
      Effect.provide(Layer.merge(BunServices.layer, recordingPueue(calls)))
    )
  )

const parallelCalls = (calls: ReadonlyArray<ReadonlyArray<string>>): ReadonlyArray<ReadonlyArray<string>> =>
  calls.filter((args) => args[0] === "parallel")

describe("the orc group's parallel count", () => {
  test("a machine with 6 slots sets its orc group to 6 before queueing instead of leaving pueue's default of 1", async () => {
    await withBacklog(async (root, checkout) => {
      await writeSlots(root, 6)
      const task = await takeTask(root)
      const calls: Array<ReadonlyArray<string>> = []
      expect(await startHere(root, checkout, task, calls)).toContain("queued " + task + " as pueue task 77")
      expect(parallelCalls(calls)).toEqual([["parallel", "6", "--group", "orc"]])
      const parallelAt = calls.findIndex((args) => args[0] === "parallel")
      const addAt = calls.findIndex((args) => args[0] === "add")
      expect(parallelAt).toBeGreaterThanOrEqual(0)
      expect(parallelAt).toBeLessThan(addAt)
    })
  })
  test("a slots change reaches the orc group at the next queued task instead of the group keeping the old count", async () => {
    await withBacklog(async (root, checkout) => {
      await writeSlots(root, 6)
      const first = await takeTask(root)
      const second = await takeTask(root)
      const calls: Array<ReadonlyArray<string>> = []
      await startHere(root, checkout, first, calls)
      await writeSlots(root, 2)
      await startHere(root, checkout, second, calls)
      expect(parallelCalls(calls)).toEqual([["parallel", "6", "--group", "orc"], ["parallel", "2", "--group", "orc"]])
    })
  })
  test("a machine with 0 slots sets its orc group to 1 instead of 0, which pueue reads as no limit", async () => {
    await withBacklog(async (root, checkout) => {
      await writeSlots(root, 0)
      const task = await takeTask(root)
      const calls: Array<ReadonlyArray<string>> = []
      await startHere(root, checkout, task, calls)
      expect(parallelCalls(calls)).toEqual([["parallel", "1", "--group", "orc"]])
    })
  })
  test("a start on another machine sends its slots with the task instead of leaving the far group at its default", async () => {
    await withBacklog(async (root, checkout) => {
      await writeSlots(root, 6)
      const task = await takeTask(root)
      const captured = join(root, "forwarded.json")
      await run(startTask(startEnv(root, checkout, task), Effect.succeed(""), { kind: "through", command: ["sh", "-c", "cat > " + captured] as const }, ["orc"] as const, root))
      const sent = Schema.decodeUnknownSync(Schema.Struct({ slots: Schema.Number }))(JSON.parse(await readFile(captured, "utf8")))
      expect(sent.slots).toBe(6)
    })
  })
})
