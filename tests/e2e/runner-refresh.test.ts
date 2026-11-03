import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { git, runOrc, withNoSandboxFixture, type NoSandboxFixture, writeScript } from "./no-sandbox-fixture"

const runTimeout = 60_000

const branchOf = (fixture: NoSandboxFixture): string =>
  git(fixture.repo, ["symbolic-ref", "--short", "HEAD"], fixture.env)

const withUpstream = (fixture: NoSandboxFixture, branch: string): string => {
  const origin = join(fixture.fakeBin, "..", "origin.git")
  git(fixture.fakeBin, ["init", "-q", "--bare", "--initial-branch=" + branch, origin], fixture.env)
  git(fixture.repo, ["remote", "add", "origin", origin], fixture.env)
  git(fixture.repo, ["push", "-q", "origin", branch], fixture.env)
  const upstream = join(fixture.fakeBin, "..", "upstream")
  git(fixture.fakeBin, ["clone", "-q", origin, upstream], fixture.env)
  git(upstream, ["config", "user.name", "orc test"], fixture.env)
  git(upstream, ["config", "user.email", "orc@test.invalid"], fixture.env)
  return upstream
}

const pushUpstream = async (fixture: NoSandboxFixture, upstream: string, branch: string, subject: string): Promise<string> => {
  await writeFile(join(upstream, subject.replace(/\s+/g, "-") + ".txt"), subject + "\n")
  git(upstream, ["add", subject.replace(/\s+/g, "-") + ".txt"], fixture.env)
  git(upstream, ["commit", "-qm", subject], fixture.env)
  git(upstream, ["push", "-q", "origin", branch], fixture.env)
  return git(upstream, ["rev-parse", "HEAD"], fixture.env)
}

const runIt = (fixture: NoSandboxFixture): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
  runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none"], fixture.repo, fixture.env)

const logGitCalls = async (fixture: NoSandboxFixture): Promise<string> => {
  const realGit = Bun.which("git") ?? "git"
  const calls = join(fixture.fakeBin, "..", "git-calls")
  await writeScript(join(fixture.fakeBin, "git"), [
    "printf '%s\\n' \"$*\" >> '" + calls + "'",
    "exec '" + realGit + "' \"$@\""
  ])
  return calls
}

const fetchCalls = async (calls: string): Promise<ReadonlyArray<string>> =>
  (await Bun.file(calls).text()).split("\n").filter((line) => line.includes("fetch --quiet"))

describe("orc run refreshes the checkout", () => {
  test("a checkout behind its remote is fast-forwarded to the remote tip, and the run branches from the new tip instead of the stale one", async () => {
    await withNoSandboxFixture(async (fixture) => {
      const branch = branchOf(fixture)
      const upstream = withUpstream(fixture, branch)
      const old = git(fixture.repo, ["rev-parse", "HEAD"], fixture.env)
      const tip = await pushUpstream(fixture, upstream, branch, "upstream change")
      const result = await runIt(fixture)
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: expect.any(String) })
      expect(result.stdout).toStartWith("fast-forwarded " + branch + " in " + fixture.repo + " from " + old.slice(0, 7) + " to " + tip.slice(0, 7) + " on origin\n")
      expect(git(fixture.repo, ["rev-parse", branch], fixture.env)).toBe(tip)
      expect(git(fixture.repo, ["log", "orc/test", "--format=%s"], fixture.env).split("\n")).toEqual(["add greeting", "upstream change", "task"])
    })
  }, runTimeout)

  test("a current checkout costs one fetch and no other network call, and is left as it was", async () => {
    await withNoSandboxFixture(async (fixture) => {
      const branch = branchOf(fixture)
      withUpstream(fixture, branch)
      const calls = await logGitCalls(fixture)
      const before = git(fixture.repo, ["rev-parse", "HEAD"], fixture.env)
      const result = await runIt(fixture)
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: expect.any(String) })
      expect(result.stdout).toStartWith(branch + " in " + fixture.repo + " is current with origin at " + before.slice(0, 7) + "\n")
      expect(await fetchCalls(calls)).toHaveLength(1)
      expect(git(fixture.repo, ["rev-parse", "HEAD"], fixture.env)).toBe(before)
    })
  }, runTimeout)

  test("a dirty checkout is refused before the refresh instead of being reset to the remote", async () => {
    await withNoSandboxFixture(async (fixture) => {
      const branch = branchOf(fixture)
      const upstream = withUpstream(fixture, branch)
      await pushUpstream(fixture, upstream, branch, "upstream change")
      const before = git(fixture.repo, ["rev-parse", "HEAD"], fixture.env)
      await writeFile(join(fixture.repo, "task.md"), "a local edit\n")
      const result = await runIt(fixture)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("holds 1 uncommitted change")
      expect(result.stdout).toBe("")
      expect(git(fixture.repo, ["rev-parse", "HEAD"], fixture.env)).toBe(before)
      expect(git(fixture.repo, ["status", "--porcelain"], fixture.env)).not.toBe("")
    })
  }, runTimeout)

  test("a diverged checkout keeps its local commit and still runs from what it holds instead of being rebased", async () => {
    await withNoSandboxFixture(async (fixture) => {
      const branch = branchOf(fixture)
      const upstream = withUpstream(fixture, branch)
      await pushUpstream(fixture, upstream, branch, "upstream change")
      await writeFile(join(fixture.repo, "local.txt"), "local\n")
      git(fixture.repo, ["add", "local.txt"], fixture.env)
      git(fixture.repo, ["commit", "-qm", "local change"], fixture.env)
      const local = git(fixture.repo, ["rev-parse", "HEAD"], fixture.env)
      const result = await runIt(fixture)
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: expect.any(String) })
      expect(result.stdout).toContain("did not refresh " + fixture.repo + " because " + branch + " has diverged from origin/" + branch + ", so the run starts from what it holds\n")
      expect(git(fixture.repo, ["rev-parse", branch], fixture.env)).toBe(local)
      expect(git(fixture.repo, ["log", "orc/test", "--format=%s"], fixture.env).split("\n")).toEqual(["add greeting", "local change", "task"])
    })
  }, runTimeout)

  test("a checkout on another branch stays on it and leaves the default branch where it was instead of switching", async () => {
    await withNoSandboxFixture(async (fixture) => {
      const branch = branchOf(fixture)
      const upstream = withUpstream(fixture, branch)
      await pushUpstream(fixture, upstream, branch, "upstream change")
      const main = git(fixture.repo, ["rev-parse", branch], fixture.env)
      git(fixture.repo, ["switch", "-q", "-c", "feature"], fixture.env)
      const result = await runIt(fixture)
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: expect.any(String) })
      expect(result.stdout).toContain("did not refresh " + fixture.repo + " because it is on feature, not the default branch " + branch + ", so the run starts from what it holds\n")
      expect(git(fixture.repo, ["rev-parse", branch], fixture.env)).toBe(main)
      expect(git(fixture.repo, ["symbolic-ref", "--short", "HEAD"], fixture.env)).toBe("feature")
    })
  }, runTimeout)

  test("a failed fetch still runs from what the checkout holds instead of refusing the start", async () => {
    await withNoSandboxFixture(async (fixture) => {
      const branch = branchOf(fixture)
      withUpstream(fixture, branch)
      git(fixture.repo, ["remote", "set-url", "origin", join(fixture.fakeBin, "gone.git")], fixture.env)
      const before = git(fixture.repo, ["rev-parse", "HEAD"], fixture.env)
      const result = await runIt(fixture)
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: expect.any(String) })
      expect(result.stdout).toStartWith("did not refresh " + fixture.repo + " because git fetch origin failed: ")
      expect(result.stdout).toContain(", so the run starts from what it holds\n")
      expect(git(fixture.repo, ["rev-parse", "HEAD"], fixture.env)).toBe(before)
    })
  }, runTimeout)
})
