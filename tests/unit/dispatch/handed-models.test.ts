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
import { prepareRoles } from "../../../packages/run/src/features/running-a-task/run-prepare"
import { RoutedModelsJson } from "../../../packages/run/src/shared/config/index"
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
          added.push(command.args.filter((word): word is string => typeof word === "string"))
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

  test("routed role models survive queueing instead of falling back to the run settings", async () => {
    const models = { implementer: "keyed/worker", fixer: "keyed/repair", reviewer: "keyed/check" }
    const run = await queuedRun({ ORC_TASK_ROUTED_MODELS: JSON.stringify(models) })
    const prefix = "ORC_DISPATCH_ROUTED_MODELS="
    const route = Schema.decodeSync(RoutedModelsJson)(run.find((word) => word.startsWith(prefix))?.slice(prefix.length) ?? "")
    const roles = await Effect.runPromise(prepareRoles(
      { projectDir: "/unused/project", orcHome: "/unused/home", agentsDir: undefined },
      { file: "config.json", models: { implementer: "legacy/worker", fixer: "legacy/repair" } },
      "direct-PR", { implementerModel: undefined, fixerModel: undefined, implementerThinking: undefined, fixerThinking: undefined }, route
    ).pipe(Effect.provide(BunServices.layer)))
    expect({ implementer: roles.agent.model, fixer: roles.fixer.model, reviewer: roles.reviewer.kind === "direct-PR" ? roles.reviewer.reviewer.model : null }).toEqual(models)
    expect(run).not.toContain("--implementer-model")
    expect(run).not.toContain("--fixer-model")
  })

  test.each(["implementer", "fixer"] as const)("a handed %s pin does not replace the other routed role", async (role) => {
    const models = { implementer: "keyed/worker", fixer: "keyed/repair" }
    const run = await queuedRun({ ORC_TASK_ROUTED_MODELS: JSON.stringify(models), ["ORC_TASK_" + role.toUpperCase() + "_MODEL"]: "keyed/pinned" })
    const args = parseArgs(run.slice(run.indexOf("run")))
    if (args.kind !== "RunAgent") {
      throw new Error("the runner did not queue orc run")
    }
    const roles = await Effect.runPromise(prepareRoles(
      { projectDir: "/unused/project", orcHome: "/unused/home", agentsDir: undefined },
      { file: "config.json" },
      undefined, args, models
    ).pipe(Effect.provide(BunServices.layer)))
    expect([roles.agent.model, roles.fixer.model]).toEqual(role === "implementer"
      ? ["keyed/pinned", "keyed/repair"]
      : ["keyed/worker", "keyed/pinned"])
  })

  test.each([
    ["implementer", "personal"],
    ["fixer", "project"]
  ] as const)("a %s agent-file model from %s settings does not replace the other routed roles", async (role, source) => {
    const root = await mkdtemp(join(tmpdir(), "orc-routed-pin-"))
    try {
      const folder = source === "personal" ? join(root, "agents") : join(root, ".orc", "agents")
      await mkdir(folder, { recursive: true })
      await writeFile(join(folder, role + ".md"), "---\nmodel: keyed/pinned\nthinking: high\ntools: read\n---\nPerform the task.\n")
      const roles = await Effect.runPromise(prepareRoles(
        { projectDir: root, orcHome: root, agentsDir: undefined },
        { file: "config.json" },
        "direct-PR", { implementerModel: undefined, fixerModel: undefined, implementerThinking: undefined, fixerThinking: undefined },
        { implementer: "keyed/worker", fixer: "keyed/repair", reviewer: "keyed/check" }
      ).pipe(Effect.provide(BunServices.layer)))
      expect([roles.agent.model, roles.fixer.model, roles.reviewer.kind === "direct-PR" ? roles.reviewer.reviewer.model : null]).toEqual(role === "implementer"
        ? ["keyed/pinned", "keyed/repair", "keyed/check"]
        : ["keyed/worker", "keyed/pinned", "keyed/check"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test.each([
    ["implementer", false, ["keyed/file", "keyed/config-repair", "keyed/config-repair"]],
    ["fixer", false, ["keyed/config-worker", "keyed/file", "keyed/file"]],
    ["implementer", true, ["keyed/file", "keyed/repair", "keyed/repair"]],
    ["fixer", true, ["keyed/worker", "keyed/file", "keyed/file"]]
  ] as const)("a %s flag with routing %s does not override its agent file or change another role", async (role, routed, expected) => {
    const root = await mkdtemp(join(tmpdir(), "orc-role-precedence-"))
    try {
      await mkdir(join(root, "agents"))
      await writeFile(join(root, "agents", role + ".md"), "---\nmodel: keyed/file\nthinking: high\ntools: read\n---\nPerform the task.\n")
      const roles = await Effect.runPromise(prepareRoles(
        { projectDir: root, orcHome: root, agentsDir: undefined },
        { file: "config.json", models: { implementer: "keyed/config-worker", fixer: "keyed/config-repair" } },
        "direct-PR", {
          implementerModel: role === "implementer" ? "keyed/flag" : undefined,
          fixerModel: role === "fixer" ? "keyed/flag" : undefined,
          implementerThinking: undefined, fixerThinking: undefined
        },
        routed ? { implementer: "keyed/worker", fixer: "keyed/repair" } : undefined
      ).pipe(Effect.provide(BunServices.layer)))
      expect([roles.agent.model, roles.fixer.model, roles.reviewer.kind === "direct-PR" ? roles.reviewer.reviewer.model : null]).toEqual([...expected])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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
