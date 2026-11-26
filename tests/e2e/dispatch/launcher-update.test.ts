import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Schema } from "effect"
import runPackage from "../../../packages/run/package.json" with { type: "json" }

const releaseVersion = "99.0.0"
const entry = "packages/run/src/bin.ts"
const repository = new URL("../../../", import.meta.url).pathname
const readBeat = Schema.decodeSync(Schema.fromJsonString(Schema.Struct({
  schema: Schema.Literal("orc.beat.v1"),
  actions: Schema.Array(Schema.Unknown)
})))

const git = (cwd: string, ...args: ReadonlyArray<string>): string => {
  const result = Bun.spawnSync(["git", ...args], { cwd })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString())
  }
  return result.stdout.toString().trim()
}

const tagRelease = async (repo: string, source: string): Promise<void> => {
  await mkdir(join(repo, "packages/run/src"), { recursive: true })
  await writeFile(join(repo, "package.json"), JSON.stringify({ name: "sample-release", version: releaseVersion }))
  await writeFile(join(repo, entry), source)
  git(repo, "init", "-q")
  git(repo, "add", ".")
  const tree = git(repo, "write-tree")
  const commit = git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", "commit-tree", tree, "-m", "Fixture")
  git(repo, "tag", "v" + releaseVersion, commit)
}

const withLauncher = async (source: string, use: (fixture: {
  readonly directory: string
  readonly readVersion: () => Promise<string>
  readonly run: (args: ReadonlyArray<string>) => Promise<{ exitCode: number; stdout: string }>
}) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-launcher-"))
  const registry = Bun.serve({ port: 0, fetch: () => Response.json({ version: releaseVersion }) })
  try {
    const home = join(root, "home")
    const orcHome = join(root, "orc-home")
    const directory = join(home, ".local", "share", "orc")
    const repo = join(root, "source")
    const selector = join(directory, "release")
    await mkdir(directory, { recursive: true })
    const backlog = join(orcHome, "backlog")
    await mkdir(backlog, { recursive: true })
    await writeFile(join(backlog, "dispatch.json"), JSON.stringify({
      machines: [],
      quota: { provider: "sample", command: ["true"], accounts: [{ name: "sample", kind: "none" }] }
    }))
    await writeFile(join(backlog, "projects.json"), JSON.stringify({ projects: [] }))
    const previous = join(directory, "v" + runPackage.version)
    await symlink(repository, previous, "dir")
    await writeFile(selector, runPackage.version + "\n")
    await tagRelease(repo, source)
    const readVersion = async () => (await readFile(selector, "utf8")).trim()
    const run = async (args: ReadonlyArray<string>) => {
      const version = await readVersion()
      const proc = Bun.spawn([process.execPath, join(directory, "v" + version, entry), ...args], {
        stdout: "pipe",
        stderr: "ignore",
        env: {
          ...process.env, HOME: home, ORC_HOME: orcHome, ORC_BEAT_UPDATE: "on", npm_config_registry: registry.url.href,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "url." + pathToFileURL(repo).href + ".insteadOf",
          GIT_CONFIG_VALUE_0: runPackage.repository.url.replace(/^git\+/, "")
        }
      })
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      return { exitCode, stdout: stdout.trim() }
    }
    await use({ directory, readVersion, run })
  } finally {
    await registry.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}

test("the beat selects a prepared release instead of changing the checkout it started in", async () => {
  await withLauncher('console.log("orc 99.0.0")\n', async ({ directory, readVersion, run }) => {
    const beat = await run(["beat", "--json"])
    expect(beat.exitCode).toBe(0)
    expect(readBeat(beat.stdout).actions).toMatchObject([
      { kind: "update", result: { outcome: "installed", running: runPackage.version, found: releaseVersion } }
    ])
    expect(await readVersion()).toBe(releaseVersion)
    expect(await run(["--version"])).toEqual({ exitCode: 0, stdout: "orc 99.0.0" })
    const previous = Bun.spawnSync([process.execPath, join(directory, "v" + runPackage.version, entry), "--version"])
    expect(previous.stdout.toString().trim()).toBe("orc " + runPackage.version)
  })
}, 60_000)

test("a release lock left by an install that exited does not stop the next beat from installing", async () => {
  await withLauncher('console.log("orc 99.0.0")\n', async ({ directory, readVersion, run }) => {
    const exited = Bun.spawn(["true"])
    await exited.exited
    await writeFile(join(directory, ".update.lock"), JSON.stringify({ pid: exited.pid, at: Date.now(), token: "exited-install" }))
    const beat = await run(["beat", "--json"])
    expect(beat.exitCode).toBe(0)
    expect(readBeat(beat.stdout).actions).toMatchObject([
      { kind: "update", result: { outcome: "installed", running: runPackage.version, found: releaseVersion } }
    ])
    expect(await readVersion()).toBe(releaseVersion)
    expect((await readdir(directory)).sort()).toEqual([".update.lock.guard", "release", "v" + runPackage.version, "v" + releaseVersion])
  })
}, 60_000)

test("the beat leaves the old release selected instead of pointing at a checkout that cannot start", async () => {
  await withLauncher('throw new Error("release cannot start")\n', async ({ directory, readVersion, run }) => {
    const beat = await run(["beat", "--json"])
    expect(beat.exitCode).toBe(0)
    expect(readBeat(beat.stdout).actions).toMatchObject([
      { kind: "update", result: { outcome: "failed", detail: "verify launcher release 99.0.0 exited 1", output: expect.stringContaining("release cannot start") } }
    ])
    expect(await readVersion()).toBe(runPackage.version)
    expect(await run(["--version"])).toEqual({ exitCode: 0, stdout: "orc " + runPackage.version })
    expect((await readdir(directory)).sort()).toEqual([".update.lock.guard", "release", "v" + runPackage.version])
  })
}, 60_000)
