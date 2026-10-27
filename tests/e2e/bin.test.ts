import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import packageJson from "../../package.json" with { type: "json" }

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
        PI_CODING_AGENT_DIR: undefined,
        PATH: fakeBin + ":" + (process.env["PATH"] ?? "")
      })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("a key held only in the keychain or in an environment variable is refused")
      expect(await readFile(join(fakeBin, "auth-checks"), "utf8")).toBe("auth check --provider opencode-go\n")
      expect(await Bun.file(join(fakeBin, "other-calls")).exists()).toBe(false)
      expect(Bun.spawnSync(["git", "rev-parse", "--verify", "-q", "orc/test"], { cwd: dir }).exitCode).not.toBe(0)
    })
  })

  test("run refuses a key pi reads only from the environment, which nono's credential capture does not see", async () => {
    await withLoginFixture("if [ -n \"$OPENCODE_API_KEY\" ]; then echo ready; exit 0; fi; echo not_ready; exit 1", async ({ dir, home, fakeBin }) => {
      const result = await runOrc(["run", "task.md", "--branch", "orc/test"], dir, {
        HOME: home,
        PI_CODING_AGENT_DIR: undefined,
        OPENCODE_API_KEY: "an-environment-key",
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
        data: { models: [{ provider: "opencode-go", id: "muse-spark-1.3-contributor", contextWindow: 262_144 }] }
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
      expect(settings).toEqual({ compaction: { modelOverrides: { "opencode-go/muse-spark-1.3-contributor": { reserveTokens: 112_144 } } } })
      const models: unknown = JSON.parse(await readFile(join(orcHome, "runs", runId, "session", "agent", "models.json"), "utf8"))
      expect(models).toEqual({ providers: { "opencode-go": { apiKey: "$OPENCODE_GO_KEY", modelOverrides: { "muse-spark-1.3-contributor": { contextWindow: 262_144 } } } } })
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
      expect(result.stderr).toContain("pi lists no model opencode-go/muse-spark-1.3-contributor")
      expect(await readdir(join(orcHome, "runs"))).toEqual([])
    })
  })
})

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
    await body({ dir, home, fakeBin })
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
}
