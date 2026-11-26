import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import packageJson from "../../packages/run/package.json" with { type: "json" }
import { runnerStartEnv, withFixture } from "./runner-helpers"

const repoRoot = fileURLToPath(new URL("../..", import.meta.url))
const buildTimeout = 300_000

const run = async (command: ReadonlyArray<string>, cwd: string, env = process.env): Promise<{ readonly exitCode: number, readonly stdout: string, readonly stderr: string }> => {
  const proc = Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "pipe", cwd, env })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { exitCode, stdout, stderr }
}

describe("release assets", () => {
  test("the checksummed release renders an attention frame without Bun and queues its own orc-dash instead of a PATH copy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-release-assets-e2e-"))
    try {
      const out = join(dir, "out")
      const built = await run([process.execPath, "run", "release:assets", out], repoRoot)
      expect(built.exitCode, built.stderr).toBe(0)

      const target = process.platform + "-" + process.arch
      const binary = "orc-" + target
      const name = "orc-" + packageJson.version + "-" + target + ".tar.gz"
      expect((await readdir(out)).toSorted()).toEqual([name, name + ".sha256", binary, binary + ".sha256"].toSorted())
      expect(built.stdout.trim().split("\n")).toEqual([join(out, binary), join(out, binary + ".sha256"), join(out, name), join(out, name + ".sha256")])
      const native = await run([join(out, binary), "--version"], dir, { ...process.env, PATH: dir })
      expect(native.exitCode, native.stderr).toBe(0)
      expect(native.stdout.trim()).toBe("orc " + packageJson.version)

      for (const file of [binary, name]) {
        const digest = createHash("sha256").update(await readFile(join(out, file))).digest("hex")
        expect(await readFile(join(out, file + ".sha256"), "utf8")).toBe(digest + "  " + file + "\n")
      }

      const unpacked = join(dir, "unpacked")
      await mkdir(unpacked)
      const extracted = await run(["tar", "-xzf", join(out, name), "-C", unpacked], dir)
      expect(extracted.exitCode).toBe(0)
      expect((await readdir(unpacked)).toSorted()).toEqual(["heavy-standin", "herdr-app", "orc", "orc-dash", "orc-dash-capture"])
      expect((await readdir(join(unpacked, "herdr-app"))).toSorted()).toEqual(["keys.json", "layouts", "mods"])

      const noBun = { ...process.env, PATH: dir }
      const version = await run([join(unpacked, "orc"), "--version"], dir, noBun)
      expect(version.exitCode, version.stderr).toBe(0)
      expect(version.stdout.trim()).toBe("orc " + packageJson.version)

      const dash = await run([join(unpacked, "orc-dash"), "--help"], dir, noBun)
      expect(dash.exitCode, dash.stderr).toBe(0)
      expect(dash.stdout).toContain("orc-dash <subcommand>")

      const fakeOrc = join(dir, "orc")
      await writeFile(fakeOrc, '#!/bin/sh\nexec /bin/cat "$ORC_QUEUE"\n')
      await chmod(fakeOrc, 0o755)
      const frame = await run([join(unpacked, "orc-dash"), "panel", "attention", "--print", "--width", "60"], dir, {
        ...noBun,
        HOME: dir,
        ORC_DASH_CONFIG: join(dir, "absent.json"),
        ORC_QUEUE: join(repoRoot, "tests/fixtures/attention/open.json"),
      })
      expect(frame.exitCode, frame.stderr).toBe(0)
      expect(frame.stdout).toContain("╭─ attention ")
      expect(frame.stdout).toContain("3 open · 1 overdue")
      expect(frame.stdout).toContain("! orc-1 · user · 10m overdue")

      const capture = await run([join(unpacked, "orc-dash-capture"), "--help"], dir, noBun)
      expect(capture.exitCode, capture.stderr).toBe(0)
      expect(capture.stdout).toContain("usage: orc-dash-capture (pi-call | claude-statusline)")

      await withFixture(async (fixture) => {
        const env = { ...process.env, ...fixture.env, ...await runnerStartEnv(fixture), HOME: fixture.home }
        const started = await run([join(unpacked, "orc"), "runner", "start"], fixture.dir, env)
        expect(started.exitCode, started.stderr).toBe(0)
        const args = await readFile(join(fixture.pueue, "alerts-add-args"), "utf8")
        expect(args.trimEnd().split("\n").slice(-3)).toEqual([join(await realpath(unpacked), "orc-dash"), "alerts", "--json"])
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, buildTimeout)
})
