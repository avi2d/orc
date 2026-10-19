import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import packageJson from "../../package.json" with { type: "json" }

const binPath = new URL("../../src/bin.ts", import.meta.url).pathname

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
    const dir = await mkdtemp(join(tmpdir(), "orc-bin-login-"))
    const home = await mkdtemp(join(tmpdir(), "orc-bin-home-"))
    const fakeBin = join(home, "bin")
    try {
      await mkdir(fakeBin)
      await writeFile(join(fakeBin, "pi"), [
        "#!/bin/sh",
        "if [ \"$1\" = auth ] && [ \"$2\" = check ]; then echo \"$*\" >> \"$(dirname \"$0\")/auth-checks\"; echo not_ready; exit 1; fi",
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
      const result = await runOrc(["run", "task.md", "--branch", "orc/test"], dir, {
        HOME: home,
        PI_CODING_AGENT_DIR: undefined,
        PATH: fakeBin + ":" + (process.env["PATH"] ?? "")
      })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("keychain-only setup is refused")
      expect(await readFile(join(fakeBin, "auth-checks"), "utf8")).toBe("auth check --provider opencode-go\n")
      expect(await Bun.file(join(fakeBin, "other-calls")).exists()).toBe(false)
      expect(Bun.spawnSync(["git", "rev-parse", "--verify", "-q", "orc/test"], { cwd: dir }).exitCode).not.toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })
})
