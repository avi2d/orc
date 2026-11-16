import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Result } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { parseArgs } from "../../../packages/run/src/app/args"
import { addTask, claimTask } from "../../../packages/run/src/entities/backlog/index"
import { startTask } from "../../../packages/run/src/features/queueing-a-task/index"
import { configuredModels, routeOfAgents } from "../../../packages/run/src/shared/config/model-route"
import type { OrcConfig } from "../../../packages/run/src/shared/config/orc-config"

const spec = { title: "Fix the thing", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0 as const, created: "2026-11-15T10:00:00.000Z", body: "# Fix the thing\n" }

const recordingPueue = (added: Array<ReadonlyArray<string>>) =>
  Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner
    return ChildProcessSpawner.make((command) => {
      if (ChildProcess.isStandardCommand(command) && command.command === "pueue") {
        const verb = command.args[0] ?? ""
        if (verb === "add") {
          added.push(command.args)
        }
        return real.spawn(ChildProcess.make("sh", ["-c", verb === "group" ? "echo '{\"orc\":{}}'" : verb === "status" ? "echo '{\"tasks\":{}}'" : "echo 77"]))
      }
      return real.spawn(command)
    })
  })).pipe(Layer.provide(BunServices.layer))

const queuedRun = async (models: Record<string, string>): Promise<ReadonlyArray<string>> => {
  const root = await mkdtemp(join(tmpdir(), "orc-handed-models-"))
  try {
    const checkout = join(root, "checkout")
    await mkdir(checkout, { recursive: true })
    await Effect.runPromise(addTask(root, spec).pipe(Effect.andThen(claimTask(root, "orc-1")), Effect.provide(BunServices.layer)))
    const added: Array<ReadonlyArray<string>> = []
    const env = { ORC_TASK_ID: "orc-1", ORC_TASK_FILE: join(root, "taken", "orc-1.md"), ORC_TASK_CHECKOUT: checkout, ORC_TASK_PROVIDER: "keyed", ...models }
    await Effect.runPromise(startTask(env, Effect.succeed(""), { kind: "here" }, ["orc"] as const, root).pipe(
      Effect.provide(Layer.merge(BunServices.layer, recordingPueue(added)))
    ))
    const add = added.find((args) => args.includes("run")) ?? []
    return add.slice(add.indexOf("--") + 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("models the beat hands to orc run", () => {
  test("ORC_TASK_IMPLEMENTER_MODEL and ORC_TASK_FIXER_MODEL reach the queued orc run as flags", async () => {
    const run = await queuedRun({ ORC_TASK_IMPLEMENTER_MODEL: "keyed/coder-large", ORC_TASK_FIXER_MODEL: "keyed/coder-small" })
    const provider = run.indexOf("--provider")
    expect(run.slice(provider, provider + 6)).toEqual(["--provider", "keyed", "--implementer-model", "keyed/coder-large", "--fixer-model", "keyed/coder-small"])
  })

  test("with no models set the queued orc run carries no model flags", async () => {
    const run = await queuedRun({})
    expect(run).toContain("--provider")
    expect(run).not.toContain("--implementer-model")
    expect(run).not.toContain("--fixer-model")
  })

  test("orc run reads --implementer-model and --fixer-model apart from the task file", () => {
    expect(parseArgs(["run", "task.md", "--implementer-model", "keyed/one", "--fixer-model", "keyed/two"])).toMatchObject({ kind: "RunAgent", taskFile: "task.md", implementerModel: "keyed/one", fixerModel: "keyed/two" })
    expect(parseArgs(["run", "task.md", "--fixer-model", "a/b", "--fixer-model", "a/c"])).toEqual({ kind: "UsageError", detail: "orc run takes --fixer-model once, with a model" })
  })

  const keyed = { id: "keyed", credential: "token-file", tokenFile: { env: "KEYED_TOKEN_FILE" } } as const
  const config: OrcConfig = { file: "/home/me/.orc/config.json", providers: [{ id: "acme", credential: "pi-login" }, keyed], models: { implementer: "acme/coder-large", fixer: "acme/coder-small" } }

  const route = (handed: { readonly implementer: string | undefined; readonly fixer: string | undefined }) => {
    const models = configuredModels(config, handed)
    return routeOfAgents(config, { agent: models.implementer ?? "", fixer: models.fixer ?? "" }, "keyed")
  }

  test("handed models from another provider replace config.json's models, so the pinned run is not refused for a model mismatch", () => {
    expect(route({ implementer: "keyed/one", fixer: "keyed/two" })).toEqual(Result.succeed(keyed))
  })

  test("with no models handed the run keeps config.json's models and its refusal of another provider", () => {
    expect(Result.isFailure(route({ implementer: undefined, fixer: undefined }))).toBe(true)
  })
})
