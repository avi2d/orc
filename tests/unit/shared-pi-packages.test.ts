import { describe, expect, test } from "bun:test"
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path, Result } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { routeOfAgents } from "../../packages/run/src/shared/config/model-route"
import { readOrcConfig } from "../../packages/run/src/shared/config/orc-config"
import { planSandbox } from "../../packages/run/src/features/running-a-task/sandbox-plan"
import { dropPiAgentDir } from "../../packages/run/src/features/running-a-task/run-folders"

const models = { agent: "acme-bridge/coder-1", fixer: "acme-bridge/coder-1" }
const packageDir = join("git", "github.com", "acme", "bridge")

const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false)

const fakePi = (installLog: string): string => {
  const reply = JSON.stringify({ id: "orc-models", type: "response", command: "get_available_models", success: true, data: { models: [{ provider: "acme-bridge", id: "coder-1", contextWindow: 262144 }] } })
  return [
    "#!/bin/sh",
    "target=\"$PI_CODING_AGENT_DIR/" + packageDir + "\"",
    "if [ ! -d \"$target\" ]; then mkdir -p \"$target\" && echo bridge > \"$target/index.ts\" && echo \"$PI_CODING_AGENT_DIR\" >> '" + installLog + "'; fi",
    "cat > /dev/null",
    "echo '" + reply + "'"
  ].join("\n") + "\n"
}

const withRoot = async (use: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-shared-packages-"))
  try {
    await use(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const planRun = async (root: string, runId: string): Promise<string> => {
  const orcHome = join(root, "orc-home")
  const projectDir = join(root, "project")
  const runDir = join(orcHome, "runs", runId)
  const piAgentDir = join(runDir, "session", "agent")
  await mkdir(projectDir, { recursive: true })
  await mkdir(piAgentDir, { recursive: true })
  const config = await Effect.runPromise(readOrcConfig(orcHome).pipe(Effect.provide(BunServices.layer)))
  const provider = Result.getOrThrow(routeOfAgents(config, models, undefined))
  const host = { piBinary: join(root, "bin", "pi"), nodeBinary: "/bin/sh", homeDir: join(root, "operator") }
  await Effect.runPromise(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return yield* planSandbox(fs, path, spawner, host, { projectDir, runDir, piAgentDir, orcHome }, models, { config, provider, tokenFileFlag: undefined }, "none")
  }).pipe(Effect.provide(BunServices.layer)))
  return runDir
}

const setUp = async (root: string): Promise<string> => {
  const installLog = join(root, "installs.log")
  await mkdir(join(root, "bin"), { recursive: true })
  await mkdir(join(root, "orc-home"), { recursive: true })
  await mkdir(join(root, "operator"), { recursive: true })
  await writeFile(join(root, "bin", "pi"), fakePi(installLog))
  await chmod(join(root, "bin", "pi"), 0o755)
  await writeFile(join(root, "orc-home", "config.json"), JSON.stringify({
    providers: [{ id: "acme-bridge", credential: "package", packages: ["git:github.com/acme/bridge@v1"] }],
    models: { implementer: models.agent, fixer: models.fixer }
  }))
  return installLog
}

const installs = (log: string): Promise<number> => readFile(log, "utf8").then((text) => text.trim().split("\n").length, () => 0)

describe("Pi git packages shared between runs", () => {
  test("a resumed run links the one shared package folder instead of installing a second copy on each resume", async () => {
    await withRoot(async (root) => {
      const installLog = await setUp(root)
      const first = await planRun(root, "run-1")
      const resumed = await planRun(root, "run-2")
      const again = await planRun(root, "run-3")
      expect(await installs(installLog)).toBe(1)
      for (const runDir of [first, resumed, again]) {
        const linked = join(runDir, "session", "agent", "git")
        expect((await lstat(linked)).isSymbolicLink()).toBe(true)
        expect(await realpath(linked)).toBe(await realpath(join(first, "session", "agent", "git")))
        expect(await readFile(join(runDir, "session", "agent", packageDir, "index.ts"), "utf8")).toBe("bridge\n")
      }
    })
  })

  test("an ended run drops its link without deleting the shared packages the next run loads", async () => {
    await withRoot(async (root) => {
      const installLog = await setUp(root)
      const first = await planRun(root, "run-1")
      const shared = await realpath(join(first, "session", "agent", "git"))
      await Effect.runPromise(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        yield* dropPiAgentDir(fs, path, first)
      }).pipe(Effect.provide(BunServices.layer)))
      expect(await exists(join(first, "session", "agent"))).toBe(false)
      expect(await exists(join(shared, "github.com", "acme", "bridge", "index.ts"))).toBe(true)
      await planRun(root, "run-2")
      expect(await installs(installLog)).toBe(1)
    })
  })

  test("a run parked before the shared folder keeps its own copy, and the run that resumes it loads the shared one", async () => {
    await withRoot(async (root) => {
      const installLog = await setUp(root)
      const parkedCopy = join(root, "orc-home", "runs", "run-old", "session", "agent", packageDir)
      await mkdir(parkedCopy, { recursive: true })
      await writeFile(join(parkedCopy, "index.ts"), "bridge\n")
      const resumed = await planRun(root, "run-new")
      expect(await installs(installLog)).toBe(1)
      expect((await lstat(join(resumed, "session", "agent", "git"))).isSymbolicLink()).toBe(true)
      expect(await readFile(join(parkedCopy, "index.ts"), "utf8")).toBe("bridge\n")
    })
  })
})
