import { describe, expect, test } from "bun:test"
import { chmod, realpath, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type Fixture, mainToken, type OrcResult, runnerTimeout, runOrc, withFixture } from "./runner-helpers"

const realGit = Bun.which("git") ?? "git"

const gitEnv = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }

const git = (dir: string, args: ReadonlyArray<string>): string => {
  const result = Bun.spawnSync([realGit, ...args], { cwd: dir, env: { ...process.env, ...gitEnv } })
  if (result.exitCode !== 0) {
    throw new Error("the git fixture failed: git " + args.join(" ") + ": " + result.stderr.toString())
  }
  return result.stdout.toString().trim()
}

interface Remote {
  readonly bare: string
  readonly checkout: string
  readonly upstream: string
}

const cloneAs = (fixture: Fixture, bare: string, name: string): string => {
  git(fixture.dir, ["clone", "-q", bare, name])
  const dir = join(fixture.dir, name)
  git(dir, ["config", "user.name", "orc test"])
  git(dir, ["config", "user.email", "orc@test.invalid"])
  return dir
}

const commitIn = async (dir: string, file: string, subject: string): Promise<string> => {
  await writeFile(join(dir, file), subject + "\n")
  git(dir, ["add", file])
  git(dir, ["commit", "-qm", subject])
  return git(dir, ["rev-parse", "HEAD"])
}

const withRemote = async (fixture: Fixture): Promise<Remote> => {
  const bare = join(fixture.dir, "remote.git")
  const upstream = join(fixture.dir, "upstream")
  git(fixture.dir, ["init", "-q", "--bare", "--initial-branch=main", bare])
  cloneAs(fixture, bare, "upstream")
  git(upstream, ["switch", "-q", "-c", "main"])
  await commitIn(upstream, "seed.txt", "seed")
  git(upstream, ["push", "-q", "origin", "main"])
  return { bare, upstream, checkout: await realpath(cloneAs(fixture, bare, "work")) }
}

const pushUpstream = async (remote: Remote, subject: string): Promise<string> => {
  const sha = await commitIn(remote.upstream, subject.replace(/\s+/g, "-") + ".txt", subject)
  git(remote.upstream, ["push", "-q", "origin", "main"])
  return sha
}

const logGitCalls = async (fixture: Fixture): Promise<string> => {
  const calls = join(fixture.dir, "git-calls")
  await writeFile(join(fixture.dir, "bin", "git"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '" + calls + "'\nexec '" + realGit + "' \"$@\"\n")
  await chmod(join(fixture.dir, "bin", "git"), 0o755)
  return calls
}

const networkCalls = async (calls: string): Promise<ReadonlyArray<string>> =>
  (await Bun.file(calls).text()).split("\n").filter((line) => /^(fetch|pull|ls-remote|remote update)\b/.test(line))

interface Snapshot {
  readonly branch: string
  readonly head: string
  readonly main: string
  readonly status: string
}

const snapshot = (checkout: string): Snapshot => ({
  branch: git(checkout, ["rev-parse", "--abbrev-ref", "HEAD"]),
  head: git(checkout, ["rev-parse", "HEAD"]),
  main: git(checkout, ["rev-parse", "refs/heads/main"]),
  status: git(checkout, ["status", "--porcelain"])
})

const queueIn = (fixture: Fixture, checkout: string): Promise<OrcResult> =>
  runOrc(fixture, ["runner", "queue"], {}, JSON.stringify({ task: "task-9", checkout, provider: "acme", tokenFile: mainToken, body: "# x\n" }))

const queuedTo = (result: OrcResult): void => {
  expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" })
  expect(result.stdout).toEndWith("queued task-9 as pueue task 77 in group orc\n")
}

const expectKept = async (fixture: Fixture, checkout: string, reason: string): Promise<void> => {
  const before = snapshot(checkout)
  const result = await queueIn(fixture, checkout)
  queuedTo(result)
  expect(result.stdout).toBe("did not refresh " + checkout + " because " + reason + ", so the run starts from what it holds\nqueued task-9 as pueue task 77 in group orc\n")
  expect(snapshot(checkout)).toEqual(before)
}

describe("orc runner queue refreshes the checkout", () => {
  test("a checkout behind its remote is fast-forwarded to the remote tip before the run is queued, not left behind", async () => {
    await withFixture(async (fixture) => {
      const remote = await withRemote(fixture)
      const old = git(remote.checkout, ["rev-parse", "HEAD"])
      const tip = await pushUpstream(remote, "upstream change")
      const result = await queueIn(fixture, remote.checkout)
      queuedTo(result)
      expect(result.stdout).toStartWith("fast-forwarded main in " + remote.checkout + " from " + old.slice(0, 7) + " to " + tip.slice(0, 7) + " on origin\n")
      expect(snapshot(remote.checkout)).toEqual({ branch: "main", head: tip, main: tip, status: "" })
    })
  }, runnerTimeout)

  test("a current checkout costs one fetch and no other network call, and is left as it was", async () => {
    await withFixture(async (fixture) => {
      const remote = await withRemote(fixture)
      const before = snapshot(remote.checkout)
      const calls = await logGitCalls(fixture)
      const result = await queueIn(fixture, remote.checkout)
      queuedTo(result)
      expect(result.stdout).toStartWith("main in " + remote.checkout + " is current with origin at " + before.head.slice(0, 7) + "\n")
      expect(await networkCalls(calls)).toEqual(["fetch --quiet --no-recurse-submodules origin"])
      expect(snapshot(remote.checkout)).toEqual(before)
    })
  }, runnerTimeout)

  test("a dirty checkout keeps its change and its commit instead of being reset to the remote", async () => {
    await withFixture(async (fixture) => {
      const remote = await withRemote(fixture)
      await pushUpstream(remote, "upstream change")
      await writeFile(join(remote.checkout, "seed.txt"), "local edit\n")
      await expectKept(fixture, remote.checkout, "it holds 1 uncommitted change")
    })
  }, runnerTimeout)

  test("a diverged checkout keeps its local commit instead of being rebased or reset", async () => {
    await withFixture(async (fixture) => {
      const remote = await withRemote(fixture)
      await pushUpstream(remote, "upstream change")
      await commitIn(remote.checkout, "local.txt", "local change")
      await expectKept(fixture, remote.checkout, "main has diverged from origin/main")
    })
  }, runnerTimeout)

  test("a checkout on another branch stays on it and leaves main where it was instead of switching", async () => {
    await withFixture(async (fixture) => {
      const remote = await withRemote(fixture)
      await pushUpstream(remote, "upstream change")
      git(remote.checkout, ["switch", "-q", "-c", "feature"])
      await expectKept(fixture, remote.checkout, "it is on feature, not the default branch main")
    })
  }, runnerTimeout)

  test("a failed fetch still queues the run from what the checkout holds instead of refusing the start", async () => {
    await withFixture(async (fixture) => {
      const remote = await withRemote(fixture)
      git(remote.checkout, ["remote", "set-url", "origin", join(fixture.dir, "gone.git")])
      const before = snapshot(remote.checkout)
      const result = await queueIn(fixture, remote.checkout)
      queuedTo(result)
      expect(result.stdout).toStartWith("did not refresh " + remote.checkout + " because git fetch origin failed: ")
      expect(result.stdout).toContain(", so the run starts from what it holds\nqueued task-9")
      expect(snapshot(remote.checkout)).toEqual(before)
    })
  }, runnerTimeout)
})
