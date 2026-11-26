import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import packageJson from "../../package.json" with { type: "json" }

const repoRoot = new URL("../..", import.meta.url).pathname
const host = `buildbox-${crypto.randomUUID().slice(0, 8)}`

const author = (): { readonly name: string; readonly email: string } => {
  const match = /^(.+?) <(.+)>$/.exec(packageJson.author)
  if (match === null) {
    throw new Error("package.json author carries no name and email")
  }
  return { name: match[1], email: match[2] }
}

let dir = ""
let clone = ""
let base = ""

const git = (args: ReadonlyArray<string>): string => {
  const { name, email } = author()
  const result = Bun.spawnSync(["git", "-c", `user.name=${name}`, "-c", `user.email=${email}`, "-c", "commit.gpgsign=false", ...args], { cwd: clone })
  if (result.exitCode !== 0) {
    throw new Error("the git fixture failed: git " + args.join(" ") + "\n" + result.stderr.toString())
  }
  return result.stdout.toString().trim()
}

const commitNote = async (file: string, line: string): Promise<string> => {
  git(["checkout", "-q", "--detach", base])
  await writeFile(join(clone, file), line + "\n")
  git(["add", file])
  git(["commit", "-q", "-m", "docs: add a deploy note"])
  return git(["rev-parse", "HEAD"])
}

const homeWithPack = async (name: string, pack: unknown): Promise<string> => {
  const home = join(dir, name)
  await mkdir(join(home, ".config", "checks"), { recursive: true })
  if (pack !== undefined) {
    await writeFile(join(home, ".config", "checks", "secrets-pack.json"), JSON.stringify(pack))
  }
  return home
}

const cleanEnv = (): Record<string, string | undefined> =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GITHUB_") && key !== "CHECKS_SECRETS_PACK" && key !== "CI")
  )

const secrets = (home: string, head: string): { readonly exitCode: number; readonly output: string } => {
  const result = Bun.spawnSync([process.execPath, join(clone, "node_modules", ".bin", "checks-secrets"), base, head], {
    cwd: clone,
    env: { ...cleanEnv(), HOME: join(clone, ".orc-home"), CHECKS_SECRETS_PACK: join(home, ".config", "checks", "secrets-pack.json") }
  })
  return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "orc-secrets-pack-"))
  clone = join(dir, "orc")
  const cloned = Bun.spawnSync(["git", "clone", "-q", repoRoot, clone])
  if (cloned.exitCode !== 0) {
    throw new Error("git clone failed: " + cloned.stderr.toString())
  }
  const installed = Bun.spawnSync([process.execPath, "install", "--frozen-lockfile"], { cwd: clone })
  if (installed.exitCode !== 0) {
    throw new Error("bun install failed in the clone: " + installed.stderr.toString())
  }
  base = git(["rev-parse", "HEAD"])
  const bin = join(clone, "node_modules", ".bin")
  const gitleaksCache = join(".orc-home", ".cache", "avi2dg-checks", "gitleaks")
  await mkdir(join(clone, ".orc-home"), { recursive: true })
  if (existsSync(join(repoRoot, gitleaksCache))) {
    await cp(join(repoRoot, gitleaksCache), join(clone, gitleaksCache), { recursive: true })
  }
  const fetched = Bun.spawnSync([process.execPath, join(bin, "checks-secrets"), base], {
    cwd: clone,
    env: { ...cleanEnv(), HOME: join(clone, ".orc-home") }
  })
  if (fetched.exitCode !== 0) {
    throw new Error("the gitleaks fetch failed in the clone: " + fetched.stdout.toString() + fetched.stderr.toString())
  }
}, 120_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("the private pack on the public line", () => {
  test("lint sends the default private pack to the secrets gate instead of omitting it", async () => {
    const gatesPath = join(clone, "node_modules", "@avi2dg", "checks", "src", "core", "gates.ts")
    const { KIT_GATES, EVERY_REPOSITORY } = await import(gatesPath)
    expect(KIT_GATES).toContainEqual(expect.objectContaining({
      bin: "checks-secrets", vector: "delivery", file: "secrets.ts", reads: "range", appliesTo: EVERY_REPOSITORY
    }))

    const bin = join(clone, "node_modules", ".bin")
    await rm(join(bin, "checks-lint"))
    await symlink(await readlink(join(bin, "checks-secrets")), join(bin, "checks-lint"))
    await writeFile(join(clone, "packages", "run", "scripts", "oxlint"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    const home = await homeWithPack("home-wiring", { hosts: [host] })
    const head = await commitNote("DEPLOY.txt", `deploy goes to ${host}`)
    const result = Bun.spawnSync([process.execPath, "run", "lint", base, head], {
      cwd: clone, env: { ...cleanEnv(), HOME: home }
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout.toString() + result.stderr.toString()).toContain("DEPLOY.txt:1 private-host")
  }, 120_000)

  test("the secrets gate fails a change that adds a host the machine's private list names instead of passing it", async () => {
    const head = await commitNote("DEPLOY.txt", `deploy goes to ${host}`)
    const result = secrets(await homeWithPack("home-hit", { hosts: [host] }), head)
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain("DEPLOY.txt:1 private-host")
    expect(result.output).not.toContain(host)
  }, 120_000)

  test("the secrets gate passes a change that adds no listed host instead of failing whenever a pack is set", async () => {
    const head = await commitNote("DEPLOY.txt", "deploy goes to the build machine")
    const result = secrets(await homeWithPack("home-clean", { hosts: [host] }), head)
    expect(result.output).toContain("the kit's rules and the private pack CHECKS_SECRETS_PACK names ran")
    expect(result.exitCode).toBe(0)
  }, 120_000)

  test("the secrets gate fails on a machine with no private list instead of running the gate without it", async () => {
    const head = await commitNote("DEPLOY.txt", "deploy goes to the build machine")
    const result = secrets(await homeWithPack("home-none", undefined), head)
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain("the private pack CHECKS_SECRETS_PACK names no file that exists")
  }, 120_000)
})
