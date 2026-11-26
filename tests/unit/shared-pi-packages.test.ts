import { describe, expect, test } from "bun:test"
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Database } from "bun:sqlite"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path, Result } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { AgentFile } from "../../packages/run/src/entities/agent/index"
import { askSetupFor } from "../../packages/run/src/entities/agent/index"
import { openDatabase } from "../../packages/run/src/entities/run-history/index"
import { subprocessNoMistakesRunner } from "../../packages/run/src/entities/review-gate/no-mistakes"
import type { QuestionAnswer } from "../../packages/run/src/entities/review-gate/index"
import { routeOfAgents } from "../../packages/run/src/shared/config/model-route"
import { readOrcConfig } from "../../packages/run/src/shared/config/orc-config"
import { planSandbox } from "../../packages/run/src/features/running-a-task/sandbox-plan"
import { dropPiAgentDir } from "../../packages/run/src/features/running-a-task/run-folders"
import { runWithHistory } from "../../packages/run/src/features/running-a-task/run"
import type { HistoryRun } from "../../packages/run/src/features/running-a-task/run-record"
import { fakeOps } from "../lib/fake-ops"

const models = { agent: "acme-bridge/coder-1", fixer: "acme-bridge/coder-1" }
const bridgeDir = join("git", "github.com", "acme", "bridge")
const relayDir = join("git", "github.com", "acme", "relay")
const sessionFileName = "2026-11-24T09-00-00-000Z_parked-1.jsonl"

interface FakeSource {
  readonly dir: string
  readonly failWhile?: string
}

const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false)

const fakePi = (installLog: string, sources: ReadonlyArray<FakeSource>): string => {
  const reply = JSON.stringify({ id: "orc-models", type: "response", command: "get_available_models", success: true, data: { models: [{ provider: "acme-bridge", id: "coder-1", contextWindow: 262144 }] } })
  const installs = sources.map((source) => {
    const failing = source.failWhile === undefined ? "" : " && [ ! -e '" + source.failWhile + "' ]"
    return "target=\"$PI_CODING_AGENT_DIR/" + source.dir + "\"; if [ ! -d \"$target\" ]" + failing + "; then mkdir -p \"$target\" && echo bridge > \"$target/index.ts\" && echo '" + source.dir + "' >> '" + installLog + "'; fi"
  })
  return ["#!/bin/sh", ...installs, "cat > /dev/null", "echo '" + reply + "'"].join("\n") + "\n"
}

const withRoot = async (use: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-shared-packages-"))
  try {
    await use(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const orcHomeOf = (root: string): string => join(root, "orc-home")
const runDirOf = (root: string, runId: string): string => join(orcHomeOf(root), "runs", runId)
const agentDirOf = (root: string, runId: string): string => join(runDirOf(root, runId), "session", "agent")

const planRun = async (root: string, runId: string): Promise<void> => {
  const orcHome = orcHomeOf(root)
  const projectDir = join(root, "project")
  const runDir = runDirOf(root, runId)
  const piAgentDir = agentDirOf(root, runId)
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
}

const setUp = async (root: string, packages: ReadonlyArray<string>, sources: ReadonlyArray<FakeSource>): Promise<string> => {
  const installLog = join(root, "installs.log")
  await mkdir(join(root, "bin"), { recursive: true })
  await mkdir(orcHomeOf(root), { recursive: true })
  await mkdir(join(root, "operator"), { recursive: true })
  await writeFile(join(root, "bin", "pi"), fakePi(installLog, sources))
  await chmod(join(root, "bin", "pi"), 0o755)
  await writeFile(join(orcHomeOf(root), "config.json"), JSON.stringify({
    providers: [{ id: "acme-bridge", credential: "package", packages }],
    models: { implementer: models.agent, fixer: models.fixer }
  }))
  return installLog
}

const installs = (log: string, dir: string): Promise<number> =>
  readFile(log, "utf8").then((text) => text.split("\n").filter((line) => line === dir).length, () => 0)

const agentFile = (kind: "implementer" | "fixer"): AgentFile => ({
  kind,
  model: models.agent,
  thinking: "high",
  tools: ["read"],
  body: "Do the task.",
  path: "bundled/" + kind + ".md",
  source: "bundled"
})

const stubGit = async (root: string): Promise<string> => {
  const git = join(root, "bin", "git")
  await writeFile(git, "#!/bin/sh\nexit 0\n")
  await chmod(git, 0o755)
  return git
}

interface Parking {
  readonly runId: string
  readonly started: string
  readonly asks: string
  readonly resumes?: { readonly runId: string; readonly answer: string }
}

const parkRun = async (root: string, db: Database, parking: Parking): Promise<string | null> => {
  const project = join(root, "project")
  const git = await stubGit(root)
  const answers: ReadonlyArray<QuestionAnswer> = parking.resumes === undefined ? [] : [{ question: parking.resumes.answer, answer: "Blue" }]
  const run = await Effect.runPromise(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const runDir = runDirOf(root, parking.runId)
    const value: HistoryRun = {
      fs, path, spawner, git, projectDir: project, runId: parking.runId, runDir,
      piSessionDir: path.join(runDir, "session"),
      hostSessionsDir: path.join(runDir, "sessions"),
      taskPath: path.join(runDir, "task.md"),
      instructions: null,
      agent: agentFile("implementer"), fixer: agentFile("fixer"), branch: "orc/sample", sandbox: "none", started: parking.started,
      asks: askSetupFor(runDir, path.join(runDir, "session"), 600, answers, []),
      worktreeDir: project,
      machine: null,
      delivery: { kind: "no-mistakes", runner: subprocessNoMistakesRunner({ spawner, binary: "no-mistakes", pathEnv: "", git, worktreeDir: project }) },
      allow: [], answers, resumeRun: parking.resumes?.runId
    }
    return value
  }).pipe(Effect.provide(BunServices.layer)))
  await mkdir(run.hostSessionsDir, { recursive: true })
  await writeFile(join(run.piSessionDir, "task.md"), "Add a sample widget.\n")
  await writeFile(run.taskPath, "Add a sample widget.\n")
  if (parking.resumes === undefined) {
    await writeFile(join(run.hostSessionsDir, sessionFileName), JSON.stringify({ type: "session", id: "parked-1", timestamp: "2026-11-24T09:00:00.000Z", cwd: project }) + "\n")
  }
  const resumed: Array<string | null> = []
  const report = await Effect.runPromise(runWithHistory(db, run, fakeOps({
    runAgent: async ({ resumeSession }) => {
      resumed.push(resumeSession)
      return { sessionId: "parked-1", commits: [], end: { kind: "asked", question: { id: parking.asks, text: "Which colour should the widget use?", asked: parking.started, blocks: true } } }
    },
    execCheck: async () => { throw new Error("checks must not run while the worker waits on an answer") }
  }, run.hostSessionsDir)))
  expect(report.completed).toBe(false)
  return resumed[0] ?? null
}

const withDb = async (root: string, use: (db: Database) => Promise<void>): Promise<void> => {
  const db = await Effect.runPromise(openDatabase(orcHomeOf(root)).pipe(Effect.provide(BunServices.layer)))
  try {
    await use(db)
  } finally {
    db.close()
  }
}

const copiedBeforeSharing = async (root: string, runId: string): Promise<string> => {
  const copy = join(agentDirOf(root, runId), bridgeDir)
  await mkdir(copy, { recursive: true })
  await writeFile(join(copy, "index.ts"), "bridge\n")
  await writeFile(join(agentDirOf(root, runId), "settings.json"), JSON.stringify({ packages: ["git:github.com/acme/bridge@v1"] }) + "\n")
  return copy
}

describe("Pi git packages shared between runs", () => {
  test("starting a run and resuming it twice links one shared package folder instead of installing a copy on each resume", async () => {
    await withRoot(async (root) => {
      const installLog = await setUp(root, ["git:github.com/acme/bridge@v1"], [{ dir: bridgeDir }])
      await withDb(root, async (db) => {
        await planRun(root, "run-1")
        await parkRun(root, db, { runId: "run-1", started: "2026-11-24T09:00:00.000Z", asks: "Q1" })
        await planRun(root, "run-2")
        expect(await parkRun(root, db, { runId: "run-2", started: "2026-11-24T10:00:00.000Z", asks: "Q2", resumes: { runId: "run-1", answer: "Q1" } }))
          .toBe(join(runDirOf(root, "run-2"), "sessions", sessionFileName))
        await planRun(root, "run-3")
        expect(await parkRun(root, db, { runId: "run-3", started: "2026-11-24T11:00:00.000Z", asks: "Q3", resumes: { runId: "run-2", answer: "Q2" } }))
          .toBe(join(runDirOf(root, "run-3"), "sessions", sessionFileName))
      })
      expect(await installs(installLog, bridgeDir)).toBe(1)
      const linked = join(agentDirOf(root, "run-3"), bridgeDir)
      const shared = await realpath(linked)
      expect(shared.startsWith(await realpath(join(orcHomeOf(root), "pi-packages")))).toBe(true)
      expect((await lstat(linked)).isSymbolicLink()).toBe(true)
      expect(await readFile(join(linked, "index.ts"), "utf8")).toBe("bridge\n")
      expect(await exists(agentDirOf(root, "run-1"))).toBe(false)
      expect(await exists(agentDirOf(root, "run-2"))).toBe(false)
    })
  })

  test("an ended run drops its link without deleting the shared packages the next run loads", async () => {
    await withRoot(async (root) => {
      const installLog = await setUp(root, ["git:github.com/acme/bridge@v1"], [{ dir: bridgeDir }])
      await planRun(root, "run-1")
      const shared = await realpath(join(agentDirOf(root, "run-1"), bridgeDir))
      await Effect.runPromise(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        yield* dropPiAgentDir(fs, path, runDirOf(root, "run-1"))
      }).pipe(Effect.provide(BunServices.layer)))
      expect(await exists(agentDirOf(root, "run-1"))).toBe(false)
      expect(await exists(join(shared, "index.ts"))).toBe(true)
      await planRun(root, "run-2")
      expect(await installs(installLog, bridgeDir)).toBe(1)
    })
  })

  test("a run parked with its own copy resumes with shared packages and drops its old copy", async () => {
    await withRoot(async (root) => {
      const installLog = await setUp(root, ["git:github.com/acme/bridge@v1"], [{ dir: bridgeDir }])
      const parkedCopy = await copiedBeforeSharing(root, "run-old")
      await withDb(root, async (db) => {
        await parkRun(root, db, { runId: "run-old", started: "2026-11-24T09:00:00.000Z", asks: "Q1" })
        await planRun(root, "run-new")
        expect(await parkRun(root, db, { runId: "run-new", started: "2026-11-24T10:00:00.000Z", asks: "Q2", resumes: { runId: "run-old", answer: "Q1" } }))
          .toBe(join(runDirOf(root, "run-new"), "sessions", sessionFileName))
      })
      expect(await installs(installLog, bridgeDir)).toBe(1)
      const resumedCopy = join(agentDirOf(root, "run-new"), bridgeDir)
      expect((await lstat(resumedCopy)).isSymbolicLink()).toBe(true)
      expect((await realpath(resumedCopy)).startsWith(await realpath(join(orcHomeOf(root), "pi-packages")))).toBe(true)
      expect(await exists(parkedCopy)).toBe(false)
    })
  })

  test("a git source with no ref installs fresh in each run instead of every run loading the first run's checkout", async () => {
    await withRoot(async (root) => {
      const installLog = await setUp(root, ["git:github.com/acme/bridge"], [{ dir: bridgeDir }])
      await planRun(root, "run-1")
      await planRun(root, "run-2")
      expect(await installs(installLog, bridgeDir)).toBe(2)
      for (const runId of ["run-1", "run-2"]) {
        expect((await lstat(join(agentDirOf(root, runId), bridgeDir))).isSymbolicLink()).toBe(false)
      }
      expect(await exists(join(orcHomeOf(root), "pi-packages"))).toBe(false)
    })
  })

  test("a source that failed to install stays out of the shared folder instead of a later run installing it into every linked run", async () => {
    await withRoot(async (root) => {
      const offline = join(root, "relay-offline")
      await writeFile(offline, "")
      const installLog = await setUp(root, ["git:github.com/acme/bridge@v1", "git:github.com/acme/relay@v1"], [{ dir: bridgeDir }, { dir: relayDir, failWhile: offline }])
      await planRun(root, "run-1")
      expect(await exists(join(agentDirOf(root, "run-1"), relayDir))).toBe(false)
      await rm(offline)
      await planRun(root, "run-2")
      expect(await exists(join(agentDirOf(root, "run-1"), relayDir))).toBe(false)
      expect((await lstat(join(agentDirOf(root, "run-2"), relayDir))).isSymbolicLink()).toBe(true)
      await planRun(root, "run-3")
      expect(await installs(installLog, bridgeDir)).toBe(1)
      expect(await installs(installLog, relayDir)).toBe(1)
      expect(await realpath(join(agentDirOf(root, "run-3"), relayDir))).toBe(await realpath(join(agentDirOf(root, "run-2"), relayDir)))
      expect(await realpath(join(agentDirOf(root, "run-3"), relayDir))).not.toBe(await realpath(join(agentDirOf(root, "run-3"), bridgeDir)))
    })
  })
})
