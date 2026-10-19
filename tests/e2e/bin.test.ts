import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import packageJson from "../../package.json" with { type: "json" }

const binPath = new URL("../../src/bin.ts", import.meta.url).pathname

const runOrc = async (args: ReadonlyArray<string>, cwd?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn([process.execPath, binPath, ...args], { stdout: "pipe", stderr: "pipe", cwd: cwd ?? process.cwd() })
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
})
