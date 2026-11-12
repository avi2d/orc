import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { addTask, claimTask } from "../../../packages/run/src/entities/backlog/index"
import { holdTask } from "../../../packages/run/src/features/backlog-planning/backlog-hold"
import { answerTask } from "../../../packages/run/src/entities/parked-runs/index"
import { startTask } from "../../../packages/run/src/features/queueing-a-task/index"

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

const spec = { title: "Fix the thing", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], created: "2026-10-27T10:00:00.000Z", body: "# Fix the thing\n" }

type BeatSpawner = Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>

const runnerPueue: BeatSpawner =
  Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner
    return ChildProcessSpawner.make((command) => {
      if (ChildProcess.isStandardCommand(command) && command.command === "pueue") {
        const verb = command.args[0] ?? ""
        return real.spawn(ChildProcess.make("sh", ["-c", verb === "group" ? "echo '{\"orc\":{}}'" : verb === "status" ? "echo '{\"tasks\":{}}'" : "echo 77"]))
      }
      return real.spawn(command)
    })
  })).pipe(Layer.provide(BunServices.layer))

describe("a released run's input", () => {
  const answeredTaken = async (root: string): Promise<void> => {
    await run(addTask(root, { ...spec, title: "Pick the API", body: "# Pick the API\nChoose.\n" }))
    await run(holdTask(root, "orc-1", { reason: "REST or gRPC", until: null, questions: [] }))
    await run(answerTask(root, "orc-1", "REST", "2026-11-02T12:00:00.000Z"))
    await run(claimTask(root, "orc-1"))
  }
  const startEnv = (root: string, checkout: string): Record<string, string> => ({
    ORC_TASK_ID: "orc-1",
    ORC_TASK_FILE: join(root, "taken", "orc-1.md"),
    ORC_TASK_CHECKOUT: checkout,
    ORC_TASK_PROVIDER: "test"
  })
  const answeredBody = (body: string): void => {
    const asked = body.indexOf("REST or gRPC")
    const answered = body.indexOf("The captain answered: REST")
    expect(body).toContain("# Pick the API\nChoose.\n")
    expect(body.indexOf("# Pick the API\nChoose.\n")).toBeLessThan(asked)
    expect(asked).toBeLessThan(answered)
  }
  test("a released run gets the task body with the captain's answer instead of the body alone", async () => {
    await withBacklog(async (root) => {
      const checkout = join(root, "checkout")
      await mkdir(checkout, { recursive: true })
      await answeredTaken(root)
      const queued = await Effect.runPromise(
        startTask(startEnv(root, checkout), Effect.succeed(""), { kind: "here" }, ["orc"] as const, root).pipe(
          Effect.provide(Layer.merge(BunServices.layer, runnerPueue))
        )
      )
      expect(queued ?? "").toContain("queued orc-1 as pueue task 77")
      const names = await readdir(join(root, "runner"))
      expect(names).toHaveLength(1)
      answeredBody(await readFile(join(root, "runner", names[0] ?? ""), "utf8"))
    })
  })
  test("a forwarded run gets the task body with the captain's answer instead of the body alone", async () => {
    await withBacklog(async (root) => {
      const checkout = join(root, "checkout")
      await mkdir(checkout, { recursive: true })
      await answeredTaken(root)
      const captured = join(root, "forwarded.json")
      const forwarded = await run(
        startTask(startEnv(root, checkout), Effect.succeed(""), { kind: "through", command: ["sh", "-c", "cat > " + captured] as const }, ["orc"] as const, root)
      )
      expect(forwarded).toBeNull()
      const body = Schema.decodeUnknownSync(Schema.Struct({ body: Schema.String }))(JSON.parse(await readFile(captured, "utf8"))).body
      answeredBody(body)
    })
  })
})
