import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const binPath = new URL("../../packages/run/src/bin.ts", import.meta.url).pathname

const token = "sk-ant-oat01-" + "Q7f".repeat(30)
const codexToken = "sk-proj-" + "Z4k".repeat(30)
const tokenShaped = /sk-(ant|proj)-[A-Za-z0-9_-]{8,}/

interface Fixture {
  readonly dir: string
  readonly home: string
  readonly bin: string
  readonly claudeLog: string
  readonly codexLog: string
}

// The fake keeps the token in a regular file and makes the credential file a FIFO, so any read of it by orc blocks until the test kills orc.
const fakeClaude = (log: string): string =>
  [
    "#!/bin/sh",
    "printf 'args=%s\\n' \"$*\" >> '" + log + "'",
    "env >> '" + log + "'",
    "printf '{\"token\":\"" + token + "\"}' > \"$CLAUDE_CONFIG_DIR/.claude.json\"",
    "mkfifo \"$CLAUDE_CONFIG_DIR/.credentials.json\"",
    "echo 'Login successful.'",
    ""
  ].join("\n")

const fakeCodex = (log: string): string =>
  [
    "#!/bin/sh",
    "printf 'args=%s\\n' \"$*\" >> '" + log + "'",
    "env >> '" + log + "'",
    "printf '{\"token\":\"" + codexToken + "\"}' > \"$CODEX_HOME/session.json\"",
    "mkfifo \"$CODEX_HOME/auth.json\"",
    "echo 'Successfully logged in'",
    ""
  ].join("\n")

const withFixture = async (body: (fixture: Fixture) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-login-e2e-"))
  try {
    const bin = join(dir, "bin")
    const claudeLog = join(dir, "claude.log")
    await mkdir(bin, { recursive: true })
    await writeFile(join(bin, "claude"), fakeClaude(claudeLog))
    await chmod(join(bin, "claude"), 0o755)
    const codexLog = join(dir, "codex.log")
    await writeFile(join(bin, "codex"), fakeCodex(codexLog))
    await chmod(join(bin, "codex"), 0o755)
    await body({ dir, home: join(dir, "home"), bin, claudeLog, codexLog })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const login = async (fixture: Fixture, account: string, env: Record<string, string>) => {
  const proc = Bun.spawn([process.execPath, binPath, "login", account], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    cwd: fixture.dir,
    env: { ...process.env, ORC_HOME: fixture.home, PATH: fixture.bin + ":" + (process.env.PATH ?? ""), SSH_CONNECTION: "", SSH_TTY: "", ...env }
  })
  let killed = false
  const deadline = setTimeout(() => {
    killed = true
    proc.kill()
  }, 15_000)
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(deadline)
  return { exitCode, stdout, stderr, killed }
}

describe("orc login", () => {
  test("runs the Claude sign-in with only the claude-main folder and leaves every other account folder alone", async () => {
    await withFixture(async (fixture) => {
      const main = join(fixture.home, "accounts", "claude-main")
      const second = join(fixture.home, "accounts", "claude-second")
      await mkdir(second, { recursive: true })
      await writeFile(join(second, "kept"), "second account")
      const ran = await login(fixture, "claude-main", { CLAUDE_CONFIG_DIR: second })
      expect(ran.stderr).toBe("")
      expect(ran.exitCode).toBe(0)
      const log = await readFile(fixture.claudeLog, "utf8")
      expect(log).toContain("args=auth login\n")
      expect(log).toContain("CLAUDE_CONFIG_DIR=" + main + "\n")
      expect(log.split("\n").filter((line) => line.includes(join(fixture.home, "accounts")))).toEqual(["CLAUDE_CONFIG_DIR=" + main])
      expect((await readdir(join(fixture.home, "accounts"))).toSorted()).toEqual(["claude-main", "claude-second"])
      expect(await readdir(second)).toEqual(["kept"])
      expect(await readFile(join(second, "kept"), "utf8")).toBe("second account")
      expect(ran.stdout).toContain("Login successful.")
      expect(ran.stdout).toContain("signed in with CLAUDE_CONFIG_DIR=" + main)
    })
  }, 30_000)

  test("prints no token-shaped value and opens no credential file", async () => {
    await withFixture(async (fixture) => {
      const ran = await login(fixture, "claude-main", {})
      expect(ran.killed).toBe(false)
      expect(ran.exitCode).toBe(0)
      expect(await readFile(join(fixture.home, "accounts", "claude-main", ".claude.json"), "utf8")).toContain(token)
      expect(ran.stdout).not.toMatch(tokenShaped)
      expect(ran.stderr).not.toMatch(tokenShaped)
    })
  }, 30_000)

  test("tells the person to open the link elsewhere on a machine reached over SSH", async () => {
    await withFixture(async (fixture) => {
      const ran = await login(fixture, "claude-main", { SSH_CONNECTION: "10.0.0.2 52000 10.0.0.1 22" })
      expect(ran.exitCode).toBe(0)
      expect(ran.stdout).toContain("This machine has no browser, so Claude prints a link")
    })
  }, 30_000)

  test("runs the Codex sign-in with only the openai folder and leaves every other account folder alone", async () => {
    await withFixture(async (fixture) => {
      const openai = join(fixture.home, "accounts", "openai")
      const main = join(fixture.home, "accounts", "claude-main")
      await mkdir(main, { recursive: true })
      await writeFile(join(main, "kept"), "claude account")
      const ran = await login(fixture, "openai", { CODEX_HOME: main })
      expect(ran.stderr).toBe("")
      expect(ran.exitCode).toBe(0)
      const log = await readFile(fixture.codexLog, "utf8")
      expect(log).toContain("args=login\n")
      expect(log).toContain("CODEX_HOME=" + openai + "\n")
      expect(log.split("\n").filter((line) => line.includes(join(fixture.home, "accounts")))).toEqual(["CODEX_HOME=" + openai])
      expect((await readdir(join(fixture.home, "accounts"))).toSorted()).toEqual(["claude-main", "openai"])
      expect(await readdir(main)).toEqual(["kept"])
      expect(existsSync(fixture.claudeLog)).toBe(false)
      expect(ran.stdout).toContain("Successfully logged in")
      expect(ran.stdout).toContain("signed in with CODEX_HOME=" + openai)
    })
  }, 30_000)

  test("prints no token-shaped value and opens no credential file for openai", async () => {
    await withFixture(async (fixture) => {
      const ran = await login(fixture, "openai", {})
      expect(ran.killed).toBe(false)
      expect(ran.exitCode).toBe(0)
      expect(await readFile(join(fixture.home, "accounts", "openai", "session.json"), "utf8")).toContain(codexToken)
      expect(ran.stdout).not.toMatch(tokenShaped)
      expect(ran.stderr).not.toMatch(tokenShaped)
    })
  }, 30_000)

  test("runs the Codex device-code sign-in on a machine reached over SSH", async () => {
    await withFixture(async (fixture) => {
      const ran = await login(fixture, "openai", { SSH_TTY: "/dev/ttys001" })
      expect(ran.exitCode).toBe(0)
      expect(await readFile(fixture.codexLog, "utf8")).toContain("args=login --device-auth\n")
      expect(ran.stdout).toContain("This machine has no browser, so Codex signs in with a device code")
    })
  }, 30_000)

  test("refuses an account that is not wired yet and makes no folder for it", async () => {
    await withFixture(async (fixture) => {
      const ran = await login(fixture, "opencode", {})
      expect(ran.exitCode).not.toBe(0)
      expect(ran.stderr).toContain("orc login opencode is not available yet")
      expect(existsSync(fixture.claudeLog)).toBe(false)
      expect(existsSync(fixture.codexLog)).toBe(false)
      expect(existsSync(join(fixture.home, "accounts", "opencode"))).toBe(false)
    })
  }, 30_000)
})
