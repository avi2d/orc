import { describe, expect, test } from "bun:test"
import packageJson from "../../package.json" with { type: "json" }

const runOrc = async (args: ReadonlyArray<string>): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn([process.execPath, "src/bin.ts", ...args], { stdout: "pipe", stderr: "pipe" })
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
})
