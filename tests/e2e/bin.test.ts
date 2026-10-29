import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Database } from "bun:sqlite"
import { BunServices } from "@effect/platform-bun"
import { Effect, Schema } from "effect"
import packageJson from "../../package.json" with { type: "json" }
import { openDatabase } from "../../packages/run/src/run-history"

const binPath = new URL("../../packages/run/src/bin.ts", import.meta.url).pathname

const runOrc = async (args: ReadonlyArray<string>, cwd?: string, env?: Record<string, string | undefined>): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn([process.execPath, binPath, ...args], { stdout: "pipe", stderr: "pipe", cwd: cwd ?? process.cwd(), env: { ...process.env, ...env } })
  const stdout = proc.stdout
  const stderr = proc.stderr
  if (!(stdout instanceof ReadableStream) || !(stderr instanceof ReadableStream)) {
    throw new Error("the orc process has no piped output")
  }
  const [out, err, exitCode] = await Promise.all([new Response(stdout).text(), new Response(stderr).text(), proc.exited])
  return { exitCode, stdout: out, stderr: err }
}

describe("orc bin", () => {
  test("--version prints the package version and exits 0", async () => {
    const result = await runOrc(["--version"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(`orc ${packageJson.version}\n`)
  })

  test("--help prints usage and exits 0", async () => {
    const result = await runOrc(["--help"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Usage: orc")
  })

  test("an unknown flag prints usage and exits non-zero", async () => {
    const result = await runOrc(["--frobnicate"])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Usage: orc")
  })

  test("run without a task file prints usage and exits non-zero", async () => {
    const result = await runOrc(["run"])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("orc run takes a task file")
  })

  test("run in a dirty checkout refuses before any agent starts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-bin-run-"))
    try {
      const git = (args: ReadonlyArray<string>): void => {
        const result = Bun.spawnSync(["git", ...args], { cwd: dir })
        if (result.exitCode !== 0) {
          throw new Error("the git fixture failed: git " + args.join(" "))
        }
      }
      git(["init", "-q"])
      await writeFile(join(dir, "task.md"), "Do nothing.\n")
      const result = await runOrc(["run", "task.md"], dir)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("uncommitted changes")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("run with no pi login refuses the keychain-only setup", async () => {
    await withLoginFixture("echo not_ready; exit 1", async ({ dir, home, fakeBin }) => {
      const result = await runOrc(["run", "task.md", "--branch", "orc/test"], dir, {
        HOME: home,
        ORC_HOME: join(home, "orc"),
        PI_CODING_AGENT_DIR: undefined,
        PATH: fakeBin + ":" + (process.env["PATH"] ?? "")
      })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("a key held only in the keychain or in an environment variable is refused")
      expect(await readFile(join(fakeBin, "auth-checks"), "utf8")).toBe("auth check --provider acme-go\n")
      expect(await Bun.file(join(fakeBin, "other-calls")).exists()).toBe(false)
      expect(Bun.spawnSync(["git", "rev-parse", "--verify", "-q", "orc/test"], { cwd: dir }).exitCode).not.toBe(0)
    })
  })

  test("run on the bundled agents with no config.json is refused before pi is asked, instead of running a built-in model", async () => {
    await withLoginFixture("echo ready; exit 0", async ({ dir, home, fakeBin }) => {
      const orcHome = join(home, "fresh")
      const result = await runOrc(["run", "task.md", "--branch", "orc/test"], dir, { HOME: home, ORC_HOME: orcHome, PI_CODING_AGENT_DIR: undefined, PATH: fakeBin + ":" + (process.env["PATH"] ?? "") })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("names no model and " + join(orcHome, "config.json") + " names no implementer model, so name one in either")
      expect(await Bun.file(join(fakeBin, "auth-checks")).exists()).toBe(false)
      expect(await Bun.file(join(fakeBin, "other-calls")).exists()).toBe(false)
    })
  })

  test("a config.json key orc does not know is refused instead of ignored", async () => {
    await withLoginFixture("echo ready; exit 0", async ({ dir, home, fakeBin }) => {
      await writeConfig(join(home, "orc"), { ...loginConfig, provider: [] })
      const result = await runOrc(["run", "task.md", "--branch", "orc/test"], dir, { HOME: home, ORC_HOME: join(home, "orc"), PI_CODING_AGENT_DIR: undefined, PATH: fakeBin + ":" + (process.env["PATH"] ?? "") })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("cannot read " + join(home, "orc", "config.json"))
      expect(await Bun.file(join(fakeBin, "auth-checks")).exists()).toBe(false)
    })
  })

  test("a login provider config.json gives no nono entry is refused in the nono sandbox instead of sending its key nowhere", async () => {
    await withLoginFixture("echo ready; exit 0", async ({ dir, home, fakeBin }) => {
      await writeConfig(join(home, "orc"), { ...loginConfig, providers: [{ id: "acme-go", credential: "pi-login" }] })
      const result = await runOrc(["run", "task.md", "--branch", "orc/test"], dir, { HOME: home, ORC_HOME: join(home, "orc"), PI_CODING_AGENT_DIR: undefined, PATH: fakeBin + ":" + (process.env["PATH"] ?? "") })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("gives the provider acme-go no nono entry, so the nono sandbox cannot carry its key")
      expect(await Bun.file(join(fakeBin, "auth-checks")).exists()).toBe(false)
    })
  })

  test("--token-file on a login provider is refused instead of ignored", async () => {
    await withLoginFixture("echo ready; exit 0", async ({ dir, home, fakeBin }) => {
      const result = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none", "--token-file", "/secrets/main"], dir, { HOME: home, ORC_HOME: join(home, "orc"), PI_CODING_AGENT_DIR: undefined, PATH: fakeBin + ":" + (process.env["PATH"] ?? "") })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("--token-file names a token file, and " + join(home, "orc", "config.json") + " has the provider acme-go take a Pi login")
      expect(await Bun.file(join(fakeBin, "auth-checks")).exists()).toBe(false)
    })
  })

  test("run refuses a key pi reads only from the environment, which nono's credential capture does not see", async () => {
    await withLoginFixture("if [ -n \"$ACME_API_KEY\" ]; then echo ready; exit 0; fi; echo not_ready; exit 1", async ({ dir, home, fakeBin }) => {
      const result = await runOrc(["run", "task.md", "--branch", "orc/test"], dir, {
        HOME: home,
        ORC_HOME: join(home, "orc"),
        PI_CODING_AGENT_DIR: undefined,
        ACME_API_KEY: "an-environment-key",
        PATH: fakeBin + ":" + (process.env["PATH"] ?? "")
      })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("a key held only in the keychain or in an environment variable is refused")
      expect(await Bun.file(join(fakeBin, "other-calls")).exists()).toBe(false)
    })
  })

  test("run writes the 150000 token compaction mark into the run's Pi folder instead of leaving Pi's default reserve", async () => {
    await withLoginFixture("echo ready; exit 0", async ({ dir, home, fakeBin }) => {
      const reply = JSON.stringify({
        id: "orc-models",
        type: "response",
        command: "get_available_models",
        success: true,
        data: { models: [{ provider: "acme-go", id: "coder-1", contextWindow: 262_144 }] }
      })
      await writeFile(join(fakeBin, "pi"), [
        "#!/bin/sh",
        "if [ \"$1\" = auth ]; then exit 0; fi",
        "if [ \"$1\" = --mode ]; then pwd > \"$(dirname \"$0\")/rpc-cwd\"; cat > \"$(dirname \"$0\")/rpc-request\"; echo '" + reply + "'; exit 0; fi",
        "exit 2"
      ].join("\n") + "\n")
      await writeFile(join(fakeBin, "no-mistakes"), "#!/bin/sh\necho 'no-mistakes version v1.101.0'\n")
      await writeFile(join(fakeBin, "nono"), "#!/bin/sh\necho 'stopped before any sandbox' >&2\nexit 1\n")
      await chmod(join(fakeBin, "no-mistakes"), 0o755)
      await chmod(join(fakeBin, "nono"), 0o755)
      const orcHome = join(home, "orc")
      const result = await runOrc(["run", "task.md", "--branch", "orc/test"], dir, {
        HOME: home,
        ORC_HOME: orcHome,
        ORC_NO_MISTAKES_BIN: join(fakeBin, "no-mistakes"),
        PI_CODING_AGENT_DIR: undefined,
        PATH: fakeBin + ":" + (process.env["PATH"] ?? "")
      })
      expect(result.stderr).toContain("the sandbox failed to start")
      expect(JSON.parse(await readFile(join(fakeBin, "rpc-request"), "utf8"))).toEqual({ id: "orc-models", type: "get_available_models" })
      const [runId] = await readdir(join(orcHome, "runs"))
      const probeCwd = (await readFile(join(fakeBin, "rpc-cwd"), "utf8")).trim()
      expect(await realpath(probeCwd)).not.toBe(await realpath(dir))
      expect(await realpath(probeCwd)).toBe(await realpath(join(orcHome, "runs", runId)))
      const settings: unknown = JSON.parse(await readFile(join(orcHome, "runs", runId, "session", "agent", "settings.json"), "utf8"))
      expect(settings).toEqual({ compaction: { modelOverrides: { "acme-go/coder-1": { reserveTokens: 112_144 } } } })
      const models: unknown = JSON.parse(await readFile(join(orcHome, "runs", runId, "session", "agent", "models.json"), "utf8"))
      expect(models).toEqual({ providers: { "acme-go": { apiKey: "$ACME_GO_KEY", modelOverrides: { "coder-1": { contextWindow: 262_144 } } } } })
    })
  })

  test("run refuses a model pi does not list rather than starting a run with no context mark", async () => {
    await withLoginFixture("echo ready; exit 0", async ({ dir, home, fakeBin }) => {
      const reply = JSON.stringify({ id: "orc-models", type: "response", command: "get_available_models", success: true, data: { models: [] } })
      await writeFile(join(fakeBin, "pi"), [
        "#!/bin/sh",
        "if [ \"$1\" = auth ]; then exit 0; fi",
        "if [ \"$1\" = --mode ]; then cat > /dev/null; echo '" + reply + "'; exit 0; fi",
        "exit 2"
      ].join("\n") + "\n")
      const orcHome = join(home, "orc")
      const result = await runOrc(["run", "task.md", "--branch", "orc/test"], dir, {
        HOME: home,
        ORC_HOME: orcHome,
        PI_CODING_AGENT_DIR: undefined,
        PATH: fakeBin + ":" + (process.env["PATH"] ?? "")
      })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("pi lists no model acme-go/coder-1")
      expect(await readdir(join(orcHome, "runs"))).toEqual([])
    })
  })

  test("a run started without a sandbox resumes without one when the flag is dropped, instead of falling back to nono", async () => {
    await withRunnableFixture(async ({ dir, env }) => {
      const started = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none"], dir, env)
      expect(started.stderr).not.toContain("the sandbox failed to start")
      const resumed = await runOrc(["run", "--branch", "orc/test"], dir, env)
      expect(resumed.stderr).not.toContain("the sandbox failed to start")
      expect(await recordedSandboxes(env.ORC_HOME)).toEqual(["none", "none"])
    })
  })

  test("a run recorded in nono resumes in nono when the flag is dropped, instead of reading the record as no sandbox", async () => {
    await withRunnableFixture(async ({ dir, env }) => {
      await seedRecordedRun(env.ORC_HOME, dir, "nono")
      const resumed = await runOrc(["run", "--branch", "orc/test"], dir, env)
      expect(resumed.exitCode).not.toBe(0)
      expect(resumed.stderr).toContain("the sandbox failed to start")
    })
  })

  test("a resume whose flag names another sandbox than the recorded one is refused instead of switching sandbox", async () => {
    await withRunnableFixture(async ({ dir, env }) => {
      await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none"], dir, env)
      const resumed = await runOrc(["run", "--branch", "orc/test", "--sandbox", "nono"], dir, env)
      expect(resumed.exitCode).not.toBe(0)
      expect(resumed.stderr).toContain("branch orc/test started with --sandbox none, so resume refuses --sandbox nono; drop --sandbox to resume with none")
      expect(await recordedSandboxes(env.ORC_HOME)).toEqual(["none"])
    })
  })
})

interface RunnableFixture {
  readonly dir: string
  readonly env: Record<string, string | undefined> & { readonly ORC_HOME: string }
}

const withRunnableFixture = (body: (fixture: RunnableFixture) => Promise<void>): Promise<void> =>
  withLoginFixture("echo ready; exit 0", async ({ dir, home, fakeBin }) => {
    const reply = JSON.stringify({
      id: "orc-models",
      type: "response",
      command: "get_available_models",
      success: true,
      data: { models: [{ provider: "acme-go", id: "coder-1", contextWindow: 262_144 }] }
    })
    await writeFile(join(fakeBin, "pi"), [
      "#!/bin/sh",
      "if [ \"$1\" = auth ]; then exit 0; fi",
      "if [ \"$1\" = --mode ]; then cat > /dev/null; echo '" + reply + "'; exit 0; fi",
      "exit 2"
    ].join("\n") + "\n")
    await writeFile(join(fakeBin, "no-mistakes"), "#!/bin/sh\necho 'no-mistakes version v1.101.0'\n")
    await writeFile(join(fakeBin, "nono"), "#!/bin/sh\necho 'stopped before any sandbox' >&2\nexit 1\n")
    await chmod(join(fakeBin, "no-mistakes"), 0o755)
    await chmod(join(fakeBin, "nono"), 0o755)
    await body({
      dir,
      env: {
        HOME: home,
        ORC_HOME: join(home, "orc"),
        ORC_NO_MISTAKES_BIN: join(fakeBin, "no-mistakes"),
        PI_CODING_AGENT_DIR: undefined,
        PATH: fakeBin + ":" + (process.env["PATH"] ?? "")
      }
    })
  })

const withHistory = async <A>(orcHome: string, use: (db: Database) => A): Promise<A> => {
  const db = await Effect.runPromise(openDatabase(orcHome).pipe(Effect.provide(BunServices.layer)))
  try {
    return use(db)
  } finally {
    db.close()
  }
}

const SandboxRowsSchema = Schema.Array(Schema.Struct({ sandbox: Schema.NullOr(Schema.String) }))

const recordedSandboxes = (orcHome: string): Promise<ReadonlyArray<string | null>> =>
  withHistory(orcHome, (db) =>
    Schema.decodeUnknownSync(SandboxRowsSchema)(db.query("SELECT sandbox FROM runs ORDER BY started ASC, id ASC").all()).map((row) => row.sandbox)
  )

const seedRecordedRun = async (orcHome: string, dir: string, sandbox: string): Promise<void> => {
  const project = await realpath(dir)
  await withHistory(orcHome, (db) => {
    db.query("INSERT INTO runs (id, project, branch, task_file, status, started, sandbox) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("seeded-run", project, "orc/test", join(dir, "task.md"), "failed", "2026-10-19T10:00:00.000Z", sandbox)
  })
}

const loginProvider = { id: "acme-go", credential: "pi-login", nono: { upstream: "https://llm.acme.test/v1" } }

const loginConfig = { providers: [loginProvider], models: { implementer: "acme-go/coder-1", fixer: "acme-go/coder-1" } }

const writeConfig = async (orcHome: string, config: unknown): Promise<void> => {
  await mkdir(orcHome, { recursive: true })
  await writeFile(join(orcHome, "config.json"), JSON.stringify(config))
}

interface LoginFixture {
  readonly dir: string
  readonly home: string
  readonly fakeBin: string
}

const withLoginFixture = async (authCheck: string, body: (fixture: LoginFixture) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-bin-login-"))
  const home = await mkdtemp(join(tmpdir(), "orc-bin-home-"))
  const fakeBin = join(home, "bin")
  try {
    await mkdir(fakeBin)
    await writeFile(join(fakeBin, "pi"), [
      "#!/bin/sh",
      "if [ \"$1\" = auth ] && [ \"$2\" = check ]; then echo \"$*\" >> \"$(dirname \"$0\")/auth-checks\"; " + authCheck + "; fi",
      "echo \"$*\" >> \"$(dirname \"$0\")/other-calls\"",
      "exit 2"
    ].join("\n") + "\n")
    await writeFile(join(fakeBin, "node"), "#!/bin/sh\nexit 1\n")
    await chmod(join(fakeBin, "pi"), 0o755)
    await chmod(join(fakeBin, "node"), 0o755)
    const git = (args: ReadonlyArray<string>): void => {
      const result = Bun.spawnSync(["git", ...args], { cwd: dir, env: { ...process.env, HOME: home } })
      if (result.exitCode !== 0) {
        throw new Error("the git fixture failed: git " + args.join(" "))
      }
    }
    git(["init", "-q"])
    git(["config", "user.name", "orc test"])
    git(["config", "user.email", "orc@test.invalid"])
    await writeFile(join(dir, "task.md"), "Do nothing.\n")
    git(["add", "task.md"])
    git(["commit", "-qm", "task"])
    await writeConfig(join(home, "orc"), loginConfig)
    await body({ dir, home, fakeBin })
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
}
