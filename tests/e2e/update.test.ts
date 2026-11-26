import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import runPackage from "../../packages/run/package.json" with { type: "json" }

const binPath = new URL("../../packages/run/dist/bin.js", import.meta.url).pathname

const dirs: Array<string> = []

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

const standInRegistry = (latest: string) =>
  Bun.serve({
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/@avi2dg/orc/latest"
        ? Response.json({ name: "@avi2dg/orc", version: latest })
        : new Response("Not Found", { status: 404 })
  })

const orcHomeWithInstaller = async (): Promise<{ home: string; marker: string }> => {
  const home = await mkdtemp(join(tmpdir(), "orc-update-e2e-"))
  dirs.push(home)
  const installer = join(home, "install.sh")
  const marker = join(home, "installed")
  await writeFile(installer, "printf '%s' \"$1\" > \"$2\"\necho \"installed $1\"\n")
  await writeFile(join(home, "config.json"), JSON.stringify({ providers: [], update: { command: ["sh", installer, "{version}", marker] } }))
  return { home, marker }
}

const runUpdate = async (home: string, registry: string): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn([process.execPath, binPath, "update", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ORC_HOME: home, npm_config_registry: registry }
  })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { exitCode, stdout, stderr }
}

const markerText = (marker: string): Promise<string | null> => readFile(marker, "utf8").catch(() => null)

describe("orc update", () => {
  test("a newer registry version runs the install command with that version", async () => {
    const registry = standInRegistry("99.0.0")
    try {
      const { home, marker } = await orcHomeWithInstaller()
      const result = await runUpdate(home, registry.url.href)
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ schema: "orc.update.v1", found: "99.0.0", running: runPackage.version, outcome: "installed", detail: null, output: "installed 99.0.0" })
      expect(await markerText(marker)).toBe("99.0.0")
    } finally {
      await registry.stop(true)
    }
  }, 60_000)

  test("an equal registry version skips the install command", async () => {
    const registry = standInRegistry(runPackage.version)
    try {
      const { home, marker } = await orcHomeWithInstaller()
      const result = await runUpdate(home, registry.url.href)
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ schema: "orc.update.v1", found: runPackage.version, running: runPackage.version, outcome: "current", detail: null, output: null })
      expect(await markerText(marker)).toBeNull()
    } finally {
      await registry.stop(true)
    }
  }, 60_000)

  test("a registry that does not know the package leaves orc as it is and says why", async () => {
    const registry = standInRegistry("99.0.0")
    try {
      const { home, marker } = await orcHomeWithInstaller()
      const result = await runUpdate(home, registry.url.href + "missing")
      expect(result.exitCode).not.toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ schema: "orc.update.v1", found: null, running: runPackage.version, outcome: "failed", output: null })
      expect(result.stdout).toContain("/missing/@avi2dg/orc/latest answered 404")
      expect(await markerText(marker)).toBeNull()
    } finally {
      await registry.stop(true)
    }
  }, 60_000)
})
