import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import packageJson from "../../packages/run/package.json" with { type: "json" }

const repoRoot = fileURLToPath(new URL("../..", import.meta.url))
const buildTimeout = 300_000

const run = async (command: ReadonlyArray<string>, cwd: string): Promise<{ readonly exitCode: number, readonly stdout: string, readonly stderr: string }> => {
  const proc = Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "pipe", cwd })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { exitCode, stdout, stderr }
}

describe("release assets", () => {
  test("bun run release:assets writes this platform's orc archive with the compiled orc and the Herdr App, and a sha256sum line that matches the archive rather than another file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-release-assets-e2e-"))
    try {
      const out = join(dir, "out")
      const built = await run([process.execPath, "run", "release:assets", out], repoRoot)
      expect(built.exitCode).toBe(0)

      const name = "orc-" + packageJson.version + "-" + process.platform + "-" + process.arch + ".tar.gz"
      expect((await readdir(out)).toSorted()).toEqual([name, name + ".sha256"])
      expect(built.stdout.trim().split("\n")).toEqual([join(out, name), join(out, name + ".sha256")])

      const digest = createHash("sha256").update(await readFile(join(out, name))).digest("hex")
      expect(await readFile(join(out, name + ".sha256"), "utf8")).toBe(digest + "  " + name + "\n")

      const unpacked = join(dir, "unpacked")
      await mkdir(unpacked)
      const extracted = await run(["tar", "-xzf", join(out, name), "-C", unpacked], dir)
      expect(extracted.exitCode).toBe(0)
      expect((await readdir(unpacked)).toSorted()).toEqual(["herdr-app", "orc"])
      expect((await readdir(join(unpacked, "herdr-app"))).toSorted()).toEqual(["keys.json", "layouts", "mods"])

      const version = await run([join(unpacked, "orc"), "--version"], dir)
      expect(version.exitCode).toBe(0)
      expect(version.stdout.trim()).toBe("orc " + packageJson.version)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, buildTimeout)
})
