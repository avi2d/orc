import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
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

const lint = (home: string, head: string): { readonly exitCode: number; readonly output: string } => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GITHUB_") && key !== "CHECKS_SECRETS_PACK" && key !== "CI")
  )
  const result = Bun.spawnSync([process.execPath, "run", "lint", base, head], { cwd: clone, env: { ...env, HOME: home } })
  return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "orc-secrets-pack-"))
  clone = join(dir, "orc")
  const cloned = Bun.spawnSync(["git", "clone", "-q", repoRoot, clone])
  if (cloned.exitCode !== 0) {
    throw new Error("git clone failed: " + cloned.stderr.toString())
  }
  await symlink(join(repoRoot, "node_modules"), join(clone, "node_modules"))
  base = git(["rev-parse", "HEAD"])
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("the private pack on the public line", () => {
  test("lint fails a change that adds a host the machine's private list names instead of passing it", async () => {
    const head = await commitNote("DEPLOY.txt", `deploy goes to ${host}`)
    const result = lint(await homeWithPack("home-hit", { hosts: [host] }), head)
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain("DEPLOY.txt:1 private-host")
    expect(result.output).not.toContain(host)
  }, 120_000)

  test("lint passes a change that adds no listed host instead of failing whenever a pack is set", async () => {
    const head = await commitNote("DEPLOY.txt", "deploy goes to the build machine")
    const result = lint(await homeWithPack("home-clean", { hosts: [host] }), head)
    expect(result.output).toContain("the kit's rules and the private pack CHECKS_SECRETS_PACK names ran")
    expect(result.exitCode).toBe(0)
  }, 120_000)

  test("lint fails on a machine with no private list instead of running the gate without it", async () => {
    const head = await commitNote("DEPLOY.txt", "deploy goes to the build machine")
    const result = lint(await homeWithPack("home-none", undefined), head)
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain("the private pack CHECKS_SECRETS_PACK names no file that exists")
  }, 120_000)
})
