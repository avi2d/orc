import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Result, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { parseArgs } from "../../../packages/run/src/app/args"
import { resolveAgentFile } from "../../../packages/run/src/entities/agent/index"
import { addTask, claimTask } from "../../../packages/run/src/entities/backlog/index"
import { openDatabase, recordRun } from "../../../packages/run/src/entities/run-history/index"
import { startTask } from "../../../packages/run/src/features/queueing-a-task/index"
import { recordFixStart } from "../../../packages/run/src/features/running-a-task/history-write"
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

const startRun = async (handed: Record<string, string>): Promise<{ readonly added: ReadonlyArray<ReadonlyArray<string>>; readonly refusal: string | null }> => {
  const root = await mkdtemp(join(tmpdir(), "orc-handed-models-"))
  try {
    const checkout = join(root, "checkout")
    await mkdir(checkout, { recursive: true })
    await Effect.runPromise(addTask(root, spec).pipe(Effect.andThen(claimTask(root, "orc-1")), Effect.provide(BunServices.layer)))
    const added: Array<ReadonlyArray<string>> = []
    const env = { ORC_TASK_ID: "orc-1", ORC_TASK_FILE: join(root, "taken", "orc-1.md"), ORC_TASK_CHECKOUT: checkout, ORC_TASK_PROVIDER: "keyed", ...handed }
    const refusal = await Effect.runPromise(startTask(env, Effect.succeed(""), { kind: "here" }, ["orc"] as const, root).pipe(
      Effect.as(null),
      Effect.catchTag("RunnerError", (error) => Effect.succeed(error.detail)),
      Effect.provide(Layer.merge(BunServices.layer, recordingPueue(added)))
    ))
    return { added, refusal }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const queuedRun = async (handed: Record<string, string>): Promise<ReadonlyArray<string>> => {
  const { added, refusal } = await startRun(handed)
  if (refusal !== null) {
    throw new Error(refusal)
  }
  const add = added.find((args) => args.includes("run")) ?? []
  return add.slice(add.indexOf("--") + 1)
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

describe("thinking levels the beat hands to orc run", () => {
  test("ORC_TASK_IMPLEMENTER_THINKING and ORC_TASK_FIXER_THINKING reach the queued orc run as flags", async () => {
    const run = await queuedRun({ ORC_TASK_IMPLEMENTER_THINKING: "xhigh", ORC_TASK_FIXER_THINKING: "low" })
    const implementer = run.indexOf("--implementer-thinking")
    expect(run.slice(implementer, implementer + 4)).toEqual(["--implementer-thinking", "xhigh", "--fixer-thinking", "low"])
  })

  test("with no levels set the queued orc run carries no thinking flags", async () => {
    const run = await queuedRun({})
    expect(run).not.toContain("--implementer-thinking")
    expect(run).not.toContain("--fixer-thinking")
  })

  test("an unknown level is refused before pueue queues the run", async () => {
    const { added, refusal } = await startRun({ ORC_TASK_FIXER_THINKING: "huge" })
    expect(refusal).toBe("orc runner start reads ORC_TASK_FIXER_THINKING as one of off, minimal, low, medium, high, xhigh, not huge")
    expect(added.filter((args) => args.includes("run"))).toEqual([])
  })

  test("orc run reads --implementer-thinking and --fixer-thinking and refuses an unknown level", () => {
    expect(parseArgs(["run", "task.md", "--implementer-thinking", "xhigh", "--fixer-thinking", "off"])).toMatchObject({ kind: "RunAgent", taskFile: "task.md", implementerThinking: "xhigh", fixerThinking: "off" })
    expect(parseArgs(["run", "task.md", "--implementer-thinking", "huge"])).toEqual({ kind: "UsageError", detail: "orc run takes --implementer-thinking once, with off, minimal, low, medium, high, xhigh" })
  })

  const agentFile = ["---", "model: acme/pinned", "thinking: high", "tools: read, bash", "---", "Fix the findings.", ""].join("\n")

  const handedFixer = async (root: string, thinking: "low" | undefined) => {
    const project = join(root, "project")
    await mkdir(join(project, ".orc", "agents"), { recursive: true })
    await writeFile(join(project, ".orc", "agents", "fixer.md"), agentFile)
    return Effect.runPromise(resolveAgentFile("fixer", { projectDir: project, orcHome: root, agentsDir: join(root, "none"), configModel: { file: "/orc-home/config.json", model: "acme/configured" }, thinking }).pipe(
      Effect.provide(BunServices.layer)
    ))
  }

  const withRoot = async (use: (root: string) => Promise<void>): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), "orc-handed-thinking-"))
    try {
      await use(root)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  test("a handed level wins over the agent file's thinking line instead of being ignored, while the agent file's model still wins", async () => {
    await withRoot(async (root) => {
      const fixer = await handedFixer(root, "low")
      expect({ model: fixer.model, thinking: fixer.thinking }).toEqual({ model: "acme/pinned", thinking: "low" })
      expect((await handedFixer(root, undefined)).thinking).toBe("high")
    })
  })

  test("the step row in the run history records the handed level", async () => {
    await withRoot(async (root) => {
      const fixer = await handedFixer(root, "low")
      const db = await Effect.runPromise(openDatabase(join(root, "home")).pipe(Effect.provide(BunServices.layer)))
      try {
        Effect.runSync(recordRun(db, { id: "run-1", project: "orc", branch: "orc/orc-1", taskFile: "task.md", status: "running", started: "2026-11-20T10:00:00.000Z" }))
        await Effect.runPromise(recordFixStart(db, "run-1", 1, fixer, "2026-11-20T10:05:00.000Z"))
        const rows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ thinking: Schema.NullOr(Schema.String) })))(db.query("SELECT thinking FROM steps WHERE name = 'fix'").all())
        expect(rows).toEqual([{ thinking: "low" }])
      } finally {
        db.close()
      }
    })
  })
})
