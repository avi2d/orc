import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { binPath, fakeQuota, type Fixture, type OrcResult, orcOk, queuedArgs, runnerTimeout, runOrc, startWaitMillis, withFixture } from "./runner-helpers"

const placeholder = "orc-test-placeholder-not-a-token"
const renewedPlaceholder = "orc-test-renewed-placeholder"

const newYearMillis = 1_798_761_600_000
const newYear = "2027-01-01T00:00:00.000Z"
const februaryMillis = 1_801_440_000_000
const february = "2027-02-01T00:00:00.000Z"
const pastMillis = 1_767_225_600_000
const past = "2026-01-01T00:00:00.000Z"

const orc = [process.execPath, binPath] as const

const writeSession = async (file: string, expiresAt: number, extra: object = {}): Promise<void> => {
  await writeFile(file, JSON.stringify({
    claudeAiOauth: { accessToken: placeholder, expiresAt, scopes: ["user:inference"], subscriptionType: "max", ...extra }
  }))
}

const tokenDir = (fixture: Fixture, task: string): string => join(fixture.home, "runner", "tokens", task)

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777

const gone = async (path: string): Promise<boolean> => {
  const deadline = Date.now() + startWaitMillis
  while (Date.now() < deadline) {
    if (!(await stat(path).then(() => true, () => false))) {
      return true
    }
    await Bun.sleep(50)
  }
  return false
}

const appears = async (path: string): Promise<boolean> => {
  const deadline = Date.now() + startWaitMillis
  while (Date.now() < deadline) {
    if (await stat(path).then(() => true, () => false)) {
      return true
    }
    await Bun.sleep(50)
  }
  return false
}

const holdToken = async (fixture: Fixture, task: string, token: string, expiresAt: string): Promise<void> => {
  const result = await runOrc(fixture, ["runner", "queue"], {}, JSON.stringify({ task, checkout: fixture.checkout, provider: "acme", body: "# x\n", token, expiresAt }))
  if (result.exitCode !== 0) {
    throw new Error("orc runner queue exited " + result.exitCode + ": " + result.stderr)
  }
}

const hold = (fixture: Fixture, task: string, script: string): Promise<OrcResult> =>
  runOrc(fixture, ["runner", "hold", task, "--", "sh", "-c", script, "orc-test-run", join(tokenDir(fixture, task), "token")])

const writeMachine = async (fixture: Fixture, session: string, renew: boolean): Promise<void> => {
  await writeFile(join(fixture.home, "backlog", "dispatch.json"), JSON.stringify({
    machines: [{ name: "linux", slots: 1, start: [...orc, "runner", "start"], renew: renew ? [...orc, "runner", "renew"] : ["false"] }],
    quota: { provider: "acme", command: ["orc-quota"], accounts: [{ name: "main", tokenCommand: [...orc, "runner", "token", session] }], floorPercent: 15 }
  }))
}

const runningTask = (id: number, label: string) => ({
  id,
  created_at: "2026-10-28T02:36:41.080925312+03:00",
  original_command: "orc runner hold",
  command: "orc runner hold",
  path: "/checkout",
  envs: {},
  group: "orc",
  dependencies: [],
  priority: 0,
  label,
  status: { Running: { enqueued_at: "2026-10-28T02:36:41.080914903+03:00", start: "2026-10-28T02:36:41.331824562+03:00" } }
})

const runsInPueue = (fixture: Fixture, task: string): Promise<void> =>
  writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: { "77": runningTask(77, task) }, groups: {} }))

const filesUnder = async (dir: string): Promise<ReadonlyArray<string>> =>
  (await readdir(dir, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name))

const filesHolding = async (dir: string, text: string, except: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
  const holding: Array<string> = []
  for (const file of await filesUnder(dir)) {
    if (!except.includes(file) && (await readFile(file, "utf8")).includes(text)) {
      holding.push(file)
    }
  }
  return holding
}

describe("orc runner token", () => {
  test("prints an armed rolling session's access token with its expiry in ISO time instead of epoch milliseconds", async () => {
    await withFixture(async (fixture) => {
      const session = join(fixture.dir, "session-token.json")
      await writeSession(session, newYearMillis)
      const result = await runOrc(fixture, ["runner", "token", session])
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ schema: "orc.token.v1", token: placeholder, expiresAt: newYear })
    })
  }, runnerTimeout)

  test("a session holding a refresh token is refused instead of sending its access token off the Mac", async () => {
    await withFixture(async (fixture) => {
      const session = join(fixture.dir, "session-token.json")
      await writeSession(session, newYearMillis, { refreshToken: placeholder })
      const result = await runOrc(fixture, ["runner", "token", session])
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toBe("")
      expect(result.stderr).toBe("orc: " + session + " holds a refresh token, so clauth has not armed it with rolling-token and its login would leave this machine\n")
    })
  }, runnerTimeout)

  test("a session with no expiry is refused without echoing the file", async () => {
    await withFixture(async (fixture) => {
      const session = join(fixture.dir, "session-token.json")
      await writeFile(session, JSON.stringify({ claudeAiOauth: { accessToken: placeholder } }))
      const result = await runOrc(fixture, ["runner", "token", session])
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout + result.stderr).not.toContain(placeholder)
      expect(result.stderr).toBe("orc: " + session + " holds no Claude access token with an expiry\n")
    })
  }, runnerTimeout)

  test("a terminal on stdout is refused instead of shown the token", async () => {
    await withFixture(async (fixture) => {
      const session = join(fixture.dir, "session-token.json")
      await writeSession(session, newYearMillis)
      const shown = Bun.spawnSync(["script", "-qec", [...orc, "runner", "token", session].map((word) => "'" + word + "'").join(" "), "/dev/null"], {
        env: { ...process.env, ...fixture.env }
      })
      const screen = shown.stdout.toString()
      expect(screen).not.toContain(placeholder)
      expect(screen).toContain("orc runner token prints a token, so it writes only into a pipe and never onto a terminal")
    })
  }, runnerTimeout)
})

describe("a beat with a token command", () => {
  test("hands the token to winbox on stdin into an owner-only folder instead of an argument, a log or the worktree", async () => {
    await withFixture(async (fixture) => {
      const session = join(fixture.dir, "session-token.json")
      await fakeQuota(fixture)
      await writeSession(session, newYearMillis)
      await writeMachine(fixture, session, true)
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
      await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--machine", "linux"])
      const beat = await orcOk(fixture, ["beat"])
      const added = await queuedArgs(fixture)
      const dir = tokenDir(fixture, "task-1")
      expect(beat).toContain("started task-1 on linux with main")
      expect(beat).not.toContain(placeholder)
      expect(added?.slice(added.indexOf("--") + 1)).toEqual([
        ...orc, "runner", "hold", "task-1", "--",
        ...orc, "run", join(fixture.home, "runner", "task-1.md"), "--branch", "orc/task-1",
        "--sandbox", "none", "--provider", "acme", "--token-file", join(dir, "token")
      ])
      expect(added?.some((word) => word.includes(placeholder))).toBe(false)
      expect(await modeOf(join(fixture.home, "runner", "tokens"))).toBe(0o700)
      expect(await modeOf(dir)).toBe(0o700)
      expect(await modeOf(join(dir, "token"))).toBe(0o600)
      expect(await readFile(join(dir, "token"), "utf8")).toBe(placeholder)
      expect(await readFile(join(dir, "expires-at"), "utf8")).toBe(newYear)
      expect(await filesHolding(fixture.dir, placeholder, [session, join(dir, "token")])).toEqual([])
    })
  }, runnerTimeout)

  test("a lapsed token leaves the task waiting instead of starting it on a dead token", async () => {
    await withFixture(async (fixture) => {
      const session = join(fixture.dir, "session-token.json")
      await fakeQuota(fixture)
      await writeSession(session, pastMillis)
      await writeMachine(fixture, session, true)
      await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--machine", "linux"])
      expect(await orcOk(fixture, ["beat"])).toContain("waits task-1: the token for main runs out at " + past)
      expect(await stat(join(fixture.pueue, "added-tasks")).then(() => true, () => false)).toBe(false)
      expect(await orcOk(fixture, ["backlog"])).toStartWith("NEW (1) ")
    })
  }, runnerTimeout)

  test("the next beat renews a started run's token instead of leaving it to lapse", async () => {
    await withFixture(async (fixture) => {
      const session = join(fixture.dir, "session-token.json")
      await fakeQuota(fixture)
      await writeSession(session, newYearMillis)
      await writeMachine(fixture, session, true)
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
      await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--machine", "linux"])
      await orcOk(fixture, ["beat"])
      await queuedArgs(fixture)
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: { "77": runningTask(77, "task-1") }, groups: {} }))
      await writeSession(session, februaryMillis)
      expect(await orcOk(fixture, ["beat"])).toContain("renewed the token of task-1 on linux")
      expect(await readFile(join(tokenDir(fixture, "task-1"), "expires-at"), "utf8")).toBe(february)
    })
  }, runnerTimeout)

  test("a renewal for a run pueue no longer holds drops its folder and reports a failure instead of a renewal", async () => {
    await withFixture(async (fixture) => {
      const session = join(fixture.dir, "session-token.json")
      await fakeQuota(fixture)
      await writeSession(session, newYearMillis)
      await writeMachine(fixture, session, true)
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
      await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--machine", "linux"])
      await orcOk(fixture, ["beat"])
      await queuedArgs(fixture)
      expect(await orcOk(fixture, ["beat"])).toContain("renew failed task-1 on linux: the renew command exited 1")
      expect(await gone(tokenDir(fixture, "task-1"))).toBe(true)
    })
  }, runnerTimeout)
})

describe("orc runner queue with a token", () => {
  test("a request with both a token file and a token is refused without echoing either", async () => {
    await withFixture(async (fixture) => {
      const request = { task: "task-9", checkout: fixture.checkout, provider: "acme", body: "# x\n", tokenFile: "/secrets/main-token", token: placeholder, expiresAt: newYear }
      const result = await runOrc(fixture, ["runner", "queue"], {}, JSON.stringify(request))
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toBe("orc: the queue request on stdin is no task, checkout, provider and body with either a tokenFile or a token and an expiresAt\n")
      expect(await stat(tokenDir(fixture, "task-9")).then(() => true, () => false)).toBe(false)
    })
  }, runnerTimeout)
})

describe("orc runner hold", () => {
  const readsToken = "[ \"$(stat -c %a \"$(dirname \"$1\")\")\" = 700 ] && [ \"$(stat -c %a \"$1\")\" = 600 ] && [ \"$(cat \"$1\")\" = " + placeholder + " ]"

  test("a run that succeeds reads its owner-only token and leaves no folder behind", async () => {
    await withFixture(async (fixture) => {
      await holdToken(fixture, "task-9", placeholder, newYear)
      const result = await hold(fixture, "task-9", readsToken)
      expect(result.stderr).toBe("")
      expect(result.stdout).toBe("the run of task-9 finished\n")
      expect(await gone(tokenDir(fixture, "task-9"))).toBe(true)
    })
  }, runnerTimeout)

  test("a run that fails on a live token fails instead of rerunning and leaves no folder behind", async () => {
    await withFixture(async (fixture) => {
      await holdToken(fixture, "task-9", placeholder, newYear)
      const result = await hold(fixture, "task-9", "echo once >> '" + join(fixture.dir, "runs") + "'; exit 3")
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toBe("orc: the run of task-9 exited 3\n")
      expect(await readFile(join(fixture.dir, "runs"), "utf8")).toBe("once\n")
      expect(await gone(tokenDir(fixture, "task-9"))).toBe(true)
    })
  }, runnerTimeout)

  test("a killed holder still leaves no folder behind instead of a token on disk", async () => {
    await withFixture(async (fixture) => {
      await holdToken(fixture, "task-9", placeholder, newYear)
      const started = join(fixture.dir, "started")
      const holder = spawn("setsid", [...orc, "runner", "hold", "task-9", "--", "sh", "-c", "touch '" + started + "'; exec sleep 60"], {
        stdio: "ignore",
        env: { ...process.env, ...fixture.env }
      })
      const exited = once(holder, "exit")
      expect(await appears(started)).toBe(true)
      process.kill(-(holder.pid ?? 0), "SIGKILL")
      await exited
      expect(await gone(tokenDir(fixture, "task-9"))).toBe(true)
    })
  }, runnerTimeout)

  test("a lapsed token makes the run wait for a renewal instead of failing, then run on the fresh one", async () => {
    await withFixture(async (fixture) => {
      await holdToken(fixture, "task-9", placeholder, past)
      await runsInPueue(fixture, "task-9")
      const seen = join(fixture.dir, "seen")
      const holding = hold(fixture, "task-9", "cat \"$1\" > '" + seen + "'")
      await Bun.sleep(1_000)
      expect(await readFile(seen, "utf8").catch(() => null)).toBeNull()
      const renewal = await runOrc(fixture, ["runner", "renew"], {}, JSON.stringify({ task: "task-9", token: renewedPlaceholder, expiresAt: newYear }))
      expect(renewal.stdout).toBe("renewed the token for task-9 until " + newYear + "\n")
      const result = await holding
      expect(result.stdout).toBe("task-9 waits for a fresh token from the Mac: the one held here runs out at " + past + "\nthe run of task-9 finished\n")
      expect(await readFile(seen, "utf8")).toBe(renewedPlaceholder)
      expect(await gone(tokenDir(fixture, "task-9"))).toBe(true)
    })
  }, runnerTimeout)

  test("a run that fails as its token runs out reruns on the renewed token instead of failing", async () => {
    await withFixture(async (fixture) => {
      const lapsesAt = Date.now() + 10_000
      const soon = new Date(lapsesAt + 5 * 60_000).toISOString()
      await holdToken(fixture, "task-9", placeholder, soon)
      await runsInPueue(fixture, "task-9")
      const runs = join(fixture.dir, "runs")
      const renewed = "[ \"$(cat \"$1\")\" = " + renewedPlaceholder + " ]"
      const holding = hold(fixture, "task-9", "cat \"$1\" >> '" + runs + "'; echo >> '" + runs + "'; " + renewed + " && exit 0; until " + renewed + "; do sleep 0.2; done; exit 1")
      expect(await appears(runs)).toBe(true)
      await Bun.sleep(Math.max(0, lapsesAt - Date.now()) + 500)
      const renewal = await runOrc(fixture, ["runner", "renew"], {}, JSON.stringify({ task: "task-9", token: renewedPlaceholder, expiresAt: newYear }))
      expect(renewal.exitCode).toBe(0)
      const result = await holding
      expect(result.stdout).toContain("the run of task-9 exited 1 as its token ran out at " + soon + ", so it resumes on a fresh one\n")
      expect(result.exitCode).toBe(0)
      expect(await readFile(runs, "utf8")).toBe(placeholder + "\n" + renewedPlaceholder + "\n")
      expect(await gone(tokenDir(fixture, "task-9"))).toBe(true)
    })
  }, runnerTimeout)

  test("a hold with no token held is refused instead of running without one", async () => {
    await withFixture(async (fixture) => {
      const result = await hold(fixture, "task-9", "exit 0")
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toBe("orc: no token is held for task-9 in " + tokenDir(fixture, "task-9") + "\n")
    })
  }, runnerTimeout)
})

describe("orc runner renew", () => {
  test("a renewal for a task pueue never queued is refused and leaves no folder", async () => {
    await withFixture(async (fixture) => {
      await holdToken(fixture, "task-9", placeholder, newYear)
      const result = await runOrc(fixture, ["runner", "renew"], {}, JSON.stringify({ task: "task-9", token: renewedPlaceholder, expiresAt: newYear }))
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toBe("orc: task-9 has no queued or running pueue task here, so no token is kept for it\n")
      expect(await gone(tokenDir(fixture, "task-9"))).toBe(true)
    })
  }, runnerTimeout)

  test("a renewal request that is no token document is refused without echoing it", async () => {
    await withFixture(async (fixture) => {
      const result = await runOrc(fixture, ["runner", "renew"], {}, JSON.stringify({ task: "task-6", token: placeholder + " tail", expiresAt: newYear }))
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toBe("orc: the renew request on stdin is no task with a token and an expiresAt\n")
    })
  }, runnerTimeout)
})
