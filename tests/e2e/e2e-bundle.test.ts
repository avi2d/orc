import { describe, expect, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const artifacts = ["bin.js", "chat-tools.ts", "heavy-standin-main.ts"]

const withFixture = async (killFirst: boolean, use: (root: string) => Promise<void>): Promise<void> => {
  const scratch = fileURLToPath(new URL("../../.orc-home/", import.meta.url))
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, "e2e-bundle-"))
  try {
    await mkdir(join(root, "tests/e2e"), { recursive: true })
    await copyFile(new URL("./bundle.ts", import.meta.url), join(root, "tests/e2e/bundle.ts"))
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { bundle: "bun fixture-build.ts" } }))
    await writeFile(join(root, "entry.ts"), [
      'import { bundlePath, ensureBundle } from "./tests/e2e/bundle.ts"',
      'process.env.E2E_BUNDLE_HOLDER = String(process.pid)',
      'ensureBundle()',
      'console.log(bundlePath)'
    ].join("\n"))
    await writeFile(join(root, "fixture-build.ts"), [
      'import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"',
      'import { join } from "node:path"',
      'if (' + JSON.stringify(killFirst) + ' && !existsSync("killed-holder")) {',
      '  writeFileSync("killed-holder", "yes")',
      '  const pid = Number(process.env.E2E_BUNDLE_HOLDER)',
      '  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid holder pid")',
      '  process.kill(pid, "SIGKILL")',
      '  process.exit(0)',
      '}',
      'if (existsSync("fail-build")) throw new Error("fixture build refused")',
      'appendFileSync("builds", "built\\n")',
      'const dist = "packages/run/dist"',
      'mkdirSync(dist, { recursive: true })',
      'for (const file of ' + JSON.stringify(artifacts) + ') writeFileSync(join(dist, file), "fixture")'
    ].join("\n"))
    await use(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const run = (root: string) => Bun.spawnSync([process.execPath, "entry.ts"], {
  cwd: root,
  stdout: "pipe",
  stderr: "pipe",
  timeout: 5_000
})

const expectBundle = async (root: string): Promise<void> => {
  const result = run(root)
  expect(result.stderr.toString()).toBe("")
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString().trim()).toBe(join(root, "packages/run/dist/bin.js"))
  for (const file of artifacts) {
    expect(await readFile(join(root, "packages/run/dist", file), "utf8")).toBe("fixture")
  }
}

describe("ensureBundle", () => {
  test("recovers a lock left by a killed holder instead of blocking the next build", async () => {
    await withFixture(true, async (root) => {
      const killed = run(root)
      expect(killed.exitCode).not.toBe(0)
      expect(await readFile(join(root, "killed-holder"), "utf8")).toBe("yes")
      await expectBundle(root)
      expect(await readFile(join(root, "builds"), "utf8")).toBe("built\n")
      expect((await readdir(join(root, "packages/run/dist"))).sort()).toEqual([...artifacts].sort())
    })
  }, 15_000)

  test("releases a failed build's lock instead of blocking a successful retry", async () => {
    await withFixture(false, async (root) => {
      await writeFile(join(root, "fail-build"), "")
      const failed = run(root)
      expect(failed.exitCode).not.toBe(0)
      expect(failed.stderr.toString()).toContain("fixture build refused")
      expect(await readdir(join(root, "packages/run/dist"))).toEqual([])
      await rm(join(root, "fail-build"))
      await expectBundle(root)
      expect(await readFile(join(root, "builds"), "utf8")).toBe("built\n")
    })
  }, 10_000)
})
