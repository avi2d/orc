import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const scriptPath = new URL("../../scripts/tested-tree.ts", import.meta.url).pathname

const sh = (dir: string, args: ReadonlyArray<string>): string => {
  const result = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    throw new Error("git " + args.join(" ") + " failed")
  }
  return Buffer.from(result.stdout).toString("utf8")
}

const runGate = async (cwd: string) => {
  const proc = Bun.spawn([process.execPath, scriptPath], { cwd, stdout: "pipe", stderr: "pipe" })
  const stdout = proc.stdout
  const stderr = proc.stderr
  if (!(stdout instanceof ReadableStream) || !(stderr instanceof ReadableStream)) {
    throw new Error("the gate process has no piped output")
  }
  const [out, err, exitCode] = await Promise.all([new Response(stdout).text(), new Response(stderr).text(), proc.exited])
  return { exitCode, stdout: out, stderr: err }
}

const initFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "orc-tested-tree-"))
  const origin = join(root, "origin.git")
  const work = join(root, "work")
  await mkdir(origin, { recursive: true })
  await mkdir(work, { recursive: true })
  sh(root, ["init", "--bare", "-q", origin])
  sh(work, ["init", "-q", "-b", "main"])
  sh(work, ["config", "user.email", "tested-tree@example.com"])
  sh(work, ["config", "user.name", "tested-tree"])
  sh(work, ["config", "commit.gpgsign", "false"])
  sh(work, ["remote", "add", "origin", origin])
  return { root, work }
}

const commitNote = async (work: string, content: string, message: string) => {
  await writeFile(join(work, "note.txt"), content)
  sh(work, ["add", "--", "note.txt"])
  sh(work, ["commit", "-q", "-m", message])
}

describe("tested-tree", () => {
  test("passes when the release commit shares a tree but not a hash with the tested pull request instead of comparing commits", async () => {
    const fixture = await initFixture()
    try {
      await commitNote(fixture.work, "same\n", "work")
      sh(fixture.work, ["push", "-q", "origin", "HEAD:refs/pull/7/head"])
      sh(fixture.work, ["commit", "-q", "--amend", "-m", "chore: release 1.2.3 (#7)"])
      const result = await runGate(fixture.work)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("matches the tree pull request #7 tested")
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 30_000)

  test("refuses a release commit whose tree moved past the tested tree instead of passing a main that moved after the full run", async () => {
    const fixture = await initFixture()
    try {
      await commitNote(fixture.work, "base\n", "base")
      sh(fixture.work, ["tag", "v0.9.0"])
      await commitNote(fixture.work, "tested\n", "work")
      sh(fixture.work, ["push", "-q", "origin", "HEAD:refs/pull/7/head"])
      await commitNote(fixture.work, "landed\n", "chore: release 1.2.3 (#7)")
      const result = await runGate(fixture.work)
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain("differs from")
      expect(result.stderr).toContain("chore: cancel the unpublished 1.2.3")
      expect(result.stderr).toContain("0.9.0")
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 30_000)

  test("refuses a subject that names no release instead of testing any commit the tag lands on", async () => {
    const fixture = await initFixture()
    try {
      await commitNote(fixture.work, "docs\n", "docs: touch the docs")
      const result = await runGate(fixture.work)
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain("is no release commit")
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 30_000)

  test("refuses a release subject that names no pull request instead of fetching an unknown ref", async () => {
    const fixture = await initFixture()
    try {
      await commitNote(fixture.work, "release\n", "chore: release 1.2.3")
      const result = await runGate(fixture.work)
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain("names no pull request")
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 30_000)
})
