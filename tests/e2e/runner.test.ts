import { describe, expect, test } from "bun:test"
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Schema } from "effect"
import { openDatabase, recordRun } from "../../packages/run/src/run-history"
import { binPath, fakeQuota, type Fixture, type OrcResult, orcOk, orcThere, queuedArgs, queuedEnv, runnerTimeout, runOrc, startWaitMillis, withFixture } from "./runner-helpers"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const queueWith = (fixture: Fixture, request: object, env: Record<string, string> = {}): Promise<OrcResult> =>
  runOrc(fixture, ["runner", "queue"], env, JSON.stringify(request))

const resultJson = async (fixture: Fixture, task: string, through: ReadonlyArray<string> = []): Promise<unknown> =>
  JSON.parse(await orcOk(fixture, ["runner", "result", task, "--json", ...through]))

const RunnerRun = Schema.Struct({ result: Schema.Struct({ run: Schema.Unknown }) })

const mainToken = "/secrets/main-token"

const writeMachine = async (fixture: Fixture, start: ReadonlyArray<string>): Promise<void> => {
  await writeFile(join(fixture.home, "backlog", "dispatch.json"), JSON.stringify({
    machines: [{ name: "linux", slots: 1, start }],
    quota: { provider: "acme", command: ["orc-quota"], accounts: [{ name: "main", tokenFile: mainToken }], floorPercent: 15 }
  }))
}

const beatStarts = async (fixture: Fixture, start: ReadonlyArray<string>): Promise<ReadonlyArray<string> | null> => {
  await fakeQuota(fixture)
  await writeMachine(fixture, start)
  await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
  await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--machine", "linux"])
  await orcOk(fixture, ["beat"])
  return queuedArgs(fixture)
}

const pueueAddFor = (home: string, checkout: string): ReadonlyArray<string> => [
  "--group", "orc", "--label", home + " task-1", "--working-directory", checkout, "--print-task-id", "--escape", "--",
  process.execPath, binPath, "run", join(home, "runner", "task-1.md"), "--branch", "orc/task-1",
  "--sandbox", "none", "--provider", "acme", "--token-file", mainToken
]

const writeTwoHomeDispatches = async (homeA: string, homeB: string, machineThroughFar: ReadonlyArray<string>): Promise<void> => {
  for (const home of [homeA, homeB]) {
    await writeFile(join(home, "backlog", "dispatch.json"), JSON.stringify({
      machines: [{ name: "linux", slots: 1, start: machineThroughFar }],
      quota: { provider: "acme", command: ["orc-quota"], accounts: [{ name: "main", tokenFile: mainToken }], floorPercent: 15 }
    }))
  }
}

const waitForAddedTasks = async (fixture: Fixture): Promise<ReadonlyArray<string>> => {
  const deadline = Date.now() + startWaitMillis
  let added: ReadonlyArray<string> = []
  while (Date.now() < deadline) {
    added = (await readFile(join(fixture.pueue, "added-tasks"), "utf8").catch(() => "")).split("\n").slice(0, -1)
    if (added.length >= 2) {
      break
    }
    await Bun.sleep(20)
  }
  return added
}

describe("orc runner start", () => {
  test("the beat's start hands the task to pueue in group orc instead of running orc itself", async () => {
    await withFixture(async (fixture) => {
      const added = await beatStarts(fixture, [process.execPath, binPath, "runner", "start"])
      expect(added).toEqual(pueueAddFor(fixture.home, fixture.checkout))
      expect(await queuedEnv(fixture)).toBe(fixture.home)
      expect(await readFile(join(fixture.home, "runner", "task-1.md"), "utf8")).toBe(await readFile(join(fixture.dir, "task.md"), "utf8"))
    })
  }, runnerTimeout)

  test("a start through a command queues on the far side's home, not the dispatcher's", async () => {
    await withFixture(async (fixture) => {
      const far = join(fixture.dir, "far-home")
      const added = await beatStarts(fixture, [process.execPath, binPath, "runner", "start", "--", ...orcThere(far)])
      const label = fixture.home + " task-1"
      expect(added).toEqual([
        "--group", "orc", "--label", label, "--working-directory", fixture.checkout, "--print-task-id", "--escape", "--",
        process.execPath, binPath, "run", join(far, "runner", "label-" + encodeURIComponent(label) + ".md"), "--branch", "orc/task-1",
        "--sandbox", "none", "--provider", "acme", "--token-file", mainToken
      ])
      expect(await queuedEnv(fixture)).toBe(far)
      expect(await readFile(join(far, "runner", "label-" + encodeURIComponent(label) + ".md"), "utf8")).toBe(await readFile(join(fixture.dir, "task.md"), "utf8"))
    })
  }, runnerTimeout)

  test("a beat closes a far-home run through its machine instead of leaving it started", async () => {
    await withFixture(async (fixture) => {
      const far = join(fixture.dir, "far-home")
      const farPueue = join(fixture.dir, "far-pueue")
      await mkdir(far, { recursive: true })
      await mkdir(farPueue, { recursive: true })
      await writeFile(join(farPueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
      const through = ["sh", "-c", "joined=\"$*\"; ORC_HOME='" + far + "' PUEUE_STATE='" + farPueue + "' eval \"exec \\\"$0\\\" '" + binPath + "' $joined\"", process.execPath]
      await fakeQuota(fixture)
      await writeMachine(fixture, [process.execPath, binPath, "runner", "start", "--", ...through])
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
      await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--machine", "linux"])
      await orcOk(fixture, ["beat"])
      const deadline = Date.now() + startWaitMillis
      while (Date.now() < deadline) {
        if (await readFile(join(farPueue, "add-args"), "utf8").then(() => true, () => false)) {
          break
        }
        await Bun.sleep(20)
      }
      expect(await readFile(join(farPueue, "add-args"), "utf8").then(() => true, () => false)).toBe(true)
      await writeFile(join(farPueue, "status.json"), JSON.stringify({
        tasks: {
          "77": {
            id: 77,
            label: fixture.home + " task-1",
            group: "orc",
            path: fixture.checkout,
            status: { Done: { start: "2026-10-28T02:36:39.176448491+03:00", end: "2026-10-28T02:36:39.489650573+03:00", result: "Success" } }
          }
        },
        groups: {}
      }))
      const second = await orcOk(fixture, ["beat"])
      expect(second).toContain("closed task-1 done")
      expect(await orcOk(fixture, ["backlog", "--json"])).toContain("\"status\":\"closed\"")
    })
  }, runnerTimeout)

  test("a relative ORC_HOME reaches the child resolved instead of relative", async () => {
    await withFixture(async (fixture) => {
      const result = await queueWith(fixture, { task: "task-9", checkout: fixture.checkout, provider: "acme", tokenFile: mainToken, body: "# x\n" }, { ORC_HOME: "rel-home" })
      expect(result.exitCode).toBe(0)
      expect(await queuedEnv(fixture)).toBe(join(fixture.dir, "rel-home"))
      expect(await readFile(join(fixture.dir, "rel-home", "runner", "task-9.md"), "utf8")).toBe("# x\n")
    })
  }, runnerTimeout)

  test("a checkout inside the repository queues at the repository root instead of the subdirectory", async () => {
    await withFixture(async (fixture) => {
      const repo = join(fixture.dir, "repo")
      const sub = join(repo, "packages", "run")
      await mkdir(sub, { recursive: true })
      const git = (args: ReadonlyArray<string>): void => {
        const done = Bun.spawnSync(["git", ...args])
        if (done.exitCode !== 0) {
          throw new Error("git " + args.join(" ") + " failed: " + done.stderr.toString())
        }
      }
      git(["init", "-q", repo])
      git(["-C", repo, "config", "user.email", "orc@test"])
      git(["-C", repo, "config", "user.name", "orc"])
      git(["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"])
      const root = await realpath(repo)
      const queued = await queueWith(fixture, { task: "task-9", checkout: sub, provider: "acme", tokenFile: mainToken, body: "# x\n" })
      expect(queued.exitCode).toBe(0)
      const args = (await readFile(join(fixture.pueue, "add-args"), "utf8")).split("\n").slice(0, -1)
      expect(args[args.indexOf("--working-directory") + 1]).toBe(root)
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: { "77": { id: 77, label: fixture.home + " task-9", group: "orc", path: sub, status: { Queued: {} } } }, groups: {} }))
      const db = await Effect.runPromise(openDatabase(fixture.home).pipe(Effect.provide(BunServices.layer)))
      try {
        Effect.runSync(recordRun(db, {
          id: "run-root",
          project: root,
          branch: "orc/task-9",
          taskFile: "task.md",
          status: "succeeded",
          started: "2026-10-28T02:36:39.200Z",
          ended: "2026-10-28T02:36:39.400Z",
          prLink: "https://github.com/avi2d/orc/pull/9"
        }))
      } finally {
        db.close()
      }
      const document = Schema.decodeUnknownSync(RunnerRun)(await resultJson(fixture, "task-9"))
      expect(document.result.run).toEqual({ id: "run-root", status: "succeeded", prLink: "https://github.com/avi2d/orc/pull/9", endReason: null })
    })
  }, runnerTimeout)

  test("a task pueue already holds in group orc is not queued twice", async () => {
    await withFixture(async (fixture) => {
      const result = await queueWith(fixture, { task: "task-1", checkout: fixture.checkout, provider: "acme", tokenFile: mainToken, body: "# Again\n" })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("task-1 is already pueue task 655 in group orc\n")
      expect(await readFile(join(fixture.pueue, "add-args"), "utf8").catch(() => null)).toBeNull()
    })
  }, runnerTimeout)

  test("a checkout missing on the machine is refused before pueue is asked", async () => {
    await withFixture(async (fixture) => {
      const result = await queueWith(fixture, { task: "task-9", checkout: join(fixture.dir, "nowhere"), provider: "acme", tokenFile: mainToken, body: "# x\n" })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toBe("orc: the checkout " + join(fixture.dir, "nowhere") + " is no folder on this machine\n")
      expect(await readFile(join(fixture.pueue, "add-args"), "utf8").catch(() => null)).toBeNull()
    })
  }, runnerTimeout)

  test("a missing orc group is created before queueing instead of refusing the start", async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.pueue, "groups.json"), JSON.stringify({ default: { status: "Running", parallel_tasks: 1 } }))
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
      const result = await queueWith(fixture, { task: "task-9", checkout: fixture.checkout, provider: "acme", tokenFile: mainToken, body: "# x\n" })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("queued task-9 as pueue task 77 in group orc\n")
      expect((await readFile(join(fixture.pueue, "group-add-args"), "utf8")).split("\n").slice(0, -1)).toEqual(["group", "add", "orc"])
    })
  }, runnerTimeout)

  test("a similarly named group is not mistaken for the orc group", async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.pueue, "groups.json"), JSON.stringify({
        default: { status: "Running", parallel_tasks: 1 },
        "orc-proof": { status: "Running", parallel_tasks: 1 }
      }))
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
      const result = await queueWith(fixture, { task: "task-9", checkout: fixture.checkout, provider: "acme", tokenFile: mainToken, body: "# x\n" })
      expect(result.exitCode).toBe(0)
      expect((await readFile(join(fixture.pueue, "group-add-args"), "utf8")).split("\n").slice(0, -1)).toEqual(["group", "add", "orc"])
    })
  }, runnerTimeout)

  test("an existing orc group is left alone instead of added again", async () => {
    await withFixture(async (fixture) => {
      const result = await queueWith(fixture, { task: "task-9", checkout: fixture.checkout, provider: "acme", tokenFile: mainToken, body: "# x\n" })
      expect(result.exitCode).toBe(0)
      expect(await readFile(join(fixture.pueue, "group-add-args"), "utf8").catch(() => null)).toBeNull()
    })
  }, runnerTimeout)

  test("a group added by a rival start is kept instead of failing the queue", async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.pueue, "groups.json"), JSON.stringify({ default: { status: "Running", parallel_tasks: 1 } }))
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
      await writeFile(join(fixture.pueue, "race-add"), "")
      const result = await queueWith(fixture, { task: "task-9", checkout: fixture.checkout, provider: "acme", tokenFile: mainToken, body: "# x\n" })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("queued task-9 as pueue task 77 in group orc\n")
    })
  }, runnerTimeout)

  test("two simultaneous first starts queue both tasks into the orc group", async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.pueue, "groups.json"), JSON.stringify({ default: { status: "Running", parallel_tasks: 1 } }))
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
      await writeFile(join(fixture.pueue, "group-gate"), "")
      const queued = Promise.all([
        queueWith(fixture, { task: "task-9", checkout: fixture.checkout, provider: "acme", tokenFile: mainToken, body: "# x\n" }),
        queueWith(fixture, { task: "task-10", checkout: fixture.checkout, provider: "acme", tokenFile: mainToken, body: "# y\n" })
      ])
      const deadline = Date.now() + startWaitMillis
      while (Date.now() < deadline) {
        const reads = await readFile(join(fixture.pueue, "group-reads"), "utf8").catch(() => "")
        if (reads.split("\n").length > 2) {
          break
        }
        await Bun.sleep(20)
      }
      await rm(join(fixture.pueue, "group-gate"), { force: true })
      const [first, second] = await queued
      expect(first.exitCode).toBe(0)
      expect(second.exitCode).toBe(0)
      expect(first.stdout).toMatch(/^queued task-9 as pueue task 7[78] in group orc\n$/)
      expect(second.stdout).toMatch(/^queued task-10 as pueue task 7[78] in group orc\n$/)
      const added = (await readFile(join(fixture.pueue, "added-tasks"), "utf8")).split("\n").slice(0, -1)
      expect(added).toHaveLength(2)
      expect(added.some((line) => line.endsWith(" task-9 orc 77") || line.endsWith(" task-9 orc 78"))).toBe(true)
      expect(added.some((line) => line.endsWith(" task-10 orc 77") || line.endsWith(" task-10 orc 78"))).toBe(true)
    })
  }, runnerTimeout)

  test("a group creation failure without the group still fails the queue", async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.pueue, "groups.json"), JSON.stringify({ default: { status: "Running", parallel_tasks: 1 } }))
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
      await writeFile(join(fixture.pueue, "fail-add"), "")
      const result = await queueWith(fixture, { task: "task-9", checkout: fixture.checkout, provider: "acme", tokenFile: mainToken, body: "# x\n" })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toBe("orc: pueue group exited 1: fake pueue cannot add groups\n")
    })
  }, runnerTimeout)

  test("a start with garbage on stdin is refused instead of queueing with no token", async () => {
    await withFixture(async (fixture) => {
      await mkdir(join(fixture.home, "backlog", "taken"), { recursive: true })
      const taskFile = join(fixture.home, "backlog", "taken", "task-9.md")
      await writeFile(taskFile, ["---", "id: 'task-9'", "title: 'Do the thing'", "project: 'orc'", "machine: null", "depends_on: []", "beat: 'beat-1'", "taken_for: 'linux'", "account: 'main'", "taken_at: '2026-10-27T10:01:00.000Z'", "created: '2026-10-27T10:00:00.000Z'", "---", "# Do the thing", ""].join("\n"))
      const result = await runOrc(fixture, ["runner", "start"], {
        ORC_TASK_ID: "task-9",
        ORC_TASK_FILE: taskFile,
        ORC_TASK_CHECKOUT: fixture.checkout,
        ORC_TASK_PROVIDER: "acme"
      }, "not a token document")
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("reads ORC_TASK_TOKEN_FILE")
      expect(await readFile(join(fixture.pueue, "add-args"), "utf8").then(() => true, () => false)).toBe(false)
    })
  }, runnerTimeout)

  test("a start with a relative token file is refused instead of queueing with no token", async () => {
    await withFixture(async (fixture) => {
      await mkdir(join(fixture.home, "backlog", "taken"), { recursive: true })
      const taskFile = join(fixture.home, "backlog", "taken", "task-9.md")
      await writeFile(taskFile, ["---", "id: 'task-9'", "title: 'Do the thing'", "project: 'orc'", "machine: null", "depends_on: []", "beat: 'beat-1'", "taken_for: 'linux'", "account: 'main'", "taken_at: '2026-10-27T10:01:00.000Z'", "created: '2026-10-27T10:00:00.000Z'", "---", "# Do the thing", ""].join("\n"))
      const result = await runOrc(fixture, ["runner", "start"], {
        ORC_TASK_ID: "task-9",
        ORC_TASK_FILE: taskFile,
        ORC_TASK_CHECKOUT: fixture.checkout,
        ORC_TASK_PROVIDER: "acme",
        ORC_TASK_TOKEN_FILE: "rel/tokens/main-token"
      })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("orc runner start cannot queue task-9")
      expect(await readFile(join(fixture.pueue, "add-args"), "utf8").then(() => true, () => false)).toBe(false)
    })
  }, runnerTimeout)
  test("a start with no task in its environment is refused instead of queueing nothing", async () => {
    await withFixture(async (fixture) => {
      const result = await runOrc(fixture, ["runner", "start"], { ORC_TASK_ID: "" })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toBe("orc: orc runner start reads ORC_TASK_ID, which the beat sets\n")
    })
  }, runnerTimeout)
})

describe("orc runner result", () => {
  test("reads each pueue state as its own result instead of one running bucket", async () => {
    await withFixture(async (fixture) => {
      const statuses = await Promise.all(["task-1", "task-2", "task-3", "task-4", "task-5", "task-6", "task-7"].map(async (task) => resultJson(fixture, task)))
      expect(statuses).toEqual([
        { schema: "orc.runner.v1", result: { task: "task-1", status: "succeeded", pueueTask: 655, run: null, started: "2026-10-28T02:36:39.176448491+03:00", ended: "2026-10-28T02:36:39.489650573+03:00" } },
        { schema: "orc.runner.v1", result: { task: "task-2", status: "failed", pueueTask: 656, run: null, started: "2026-10-28T02:36:39.500714478+03:00", ended: "2026-10-28T02:36:39.813373536+03:00", reason: "orc exited 3" } },
        { schema: "orc.runner.v1", result: { task: "task-3", status: "failed", pueueTask: 657, run: null, started: "2026-10-28T02:36:41.331824562+03:00", ended: "2026-10-28T02:36:42.246702792+03:00", reason: "the run was killed" } },
        { schema: "orc.runner.v1", result: { task: "task-4", status: "queued", pueueTask: 658, run: null } },
        { schema: "orc.runner.v1", result: { task: "task-5", status: "stashed", pueueTask: 659, run: null } },
        { schema: "orc.runner.v1", result: { task: "task-6", status: "running", pueueTask: 660, run: null, started: "2026-10-28T02:36:41.331824562+03:00" } },
        { schema: "orc.runner.v1", result: { task: "task-7", status: "unknown" } }
      ])
    })
  }, runnerTimeout)

  test("a task-1 queued by another home reads unknown instead of that home's run", async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({
        tasks: {
          "77": {
            id: 77,
            label: join(fixture.dir, "other-home") + " task-1",
            group: "orc",
            path: "/checkout",
            status: { Done: { start: "2026-10-28T02:36:39.176448491+03:00", end: "2026-10-28T02:36:39.489650573+03:00", result: "Success" } }
          }
        },
        groups: {}
      }))
      expect(await resultJson(fixture, "task-1")).toEqual({ schema: "orc.runner.v1", result: { task: "task-1", status: "unknown" } })
    })
  }, runnerTimeout)

  test("names the orc run on the task's branch with its PR, not just pueue's exit", async () => {
    await withFixture(async (fixture) => {
      const db = await Effect.runPromise(openDatabase(fixture.home).pipe(Effect.provide(BunServices.layer)))
      try {
        Effect.runSync(recordRun(db, {
          id: "run-1",
          project: "/checkout",
          branch: "orc/task-1",
          taskFile: "task.md",
          status: "succeeded",
          started: "2026-10-28T02:36:39.200Z",
          ended: "2026-10-28T02:36:39.400Z",
          prLink: "https://github.com/avi2d/orc/pull/1"
        }))
      } finally {
        db.close()
      }
      expect(await orcOk(fixture, ["runner", "result", "task-1"])).toBe([
        "task-1: succeeded as pueue task 655, 2026-10-28T02:36:39.176448491+03:00 to 2026-10-28T02:36:39.489650573+03:00",
        "orc run run-1 succeeded, PR https://github.com/avi2d/orc/pull/1",
        ""
      ].join("\n"))
    })
  }, runnerTimeout)

  test("a run on the same branch in another checkout is not attached to the task", async () => {
    await withFixture(async (fixture) => {
      const db = await Effect.runPromise(openDatabase(fixture.home).pipe(Effect.provide(BunServices.layer)))
      try {
        Effect.runSync(recordRun(db, {
          id: "run-other",
          project: "/other-checkout",
          branch: "orc/task-1",
          taskFile: "task.md",
          status: "succeeded",
          started: "2026-10-28T02:36:39.200Z",
          ended: "2026-10-28T02:36:39.400Z",
          prLink: "https://github.com/avi2d/orc/pull/9"
        }))
      } finally {
        db.close()
      }
      const document = Schema.decodeUnknownSync(RunnerRun)(await resultJson(fixture, "task-1"))
      expect(document.result.run).toBeNull()
    })
  }, runnerTimeout)

  test("a result read through a command is the far side's result, not the reader's", async () => {
    await withFixture(async (fixture) => {
      const far = join(fixture.dir, "far-home")
      const statusFile = join(fixture.pueue, "status.json")
      const status: unknown = JSON.parse(await readFile(statusFile, "utf8"))
      if (!isRecord(status) || !isRecord(status.tasks) || !isRecord(status.tasks["656"])) {
        throw new Error("the fixture holds no pueue task 656")
      }
      const near = status.tasks["656"]
      status.tasks["777"] = { ...near, id: 777, label: far + " task-2" }
      await writeFile(statusFile, JSON.stringify(status))
      const db = await Effect.runPromise(openDatabase(far).pipe(Effect.provide(BunServices.layer)))
      try {
        Effect.runSync(recordRun(db, {
          id: "run-far",
          project: "/checkout",
          branch: "orc/task-2",
          taskFile: "task.md",
          status: "succeeded",
          started: "2026-10-28T02:36:39.200Z",
          ended: "2026-10-28T02:36:39.400Z",
          prLink: "https://github.com/avi2d/orc/pull/2"
        }))
      } finally {
        db.close()
      }
      const farResult = Schema.decodeUnknownSync(RunnerRun)(await resultJson(fixture, "task-2", ["--", ...orcThere(far)]))
      const nearResult = Schema.decodeUnknownSync(RunnerRun)(await resultJson(fixture, "task-2"))
      expect(farResult.result.run).toEqual({ id: "run-far", status: "succeeded", prLink: "https://github.com/avi2d/orc/pull/2", endReason: null })
      expect(nearResult.result.run).toBeNull()
    })
  }, runnerTimeout)

  test("a result read through a splitting command still reads the far home's run instead of splitting its label", async () => {
    await withFixture(async (fixture) => {
      const far = join(fixture.dir, "far-home")
      const statusFile = join(fixture.pueue, "status.json")
      const status: unknown = JSON.parse(await readFile(statusFile, "utf8"))
      if (!isRecord(status) || !isRecord(status.tasks) || !isRecord(status.tasks["656"])) {
        throw new Error("the fixture holds no pueue task 656")
      }
      const near = status.tasks["656"]
      status.tasks["777"] = { ...near, id: 777, label: far + " task-2" }
      await writeFile(statusFile, JSON.stringify(status))
      const db = await Effect.runPromise(openDatabase(far).pipe(Effect.provide(BunServices.layer)))
      try {
        Effect.runSync(recordRun(db, {
          id: "run-far",
          project: "/checkout",
          branch: "orc/task-2",
          taskFile: "task.md",
          status: "succeeded",
          started: "2026-10-28T02:36:39.200Z",
          ended: "2026-10-28T02:36:39.400Z",
          prLink: "https://github.com/avi2d/orc/pull/2"
        }))
      } finally {
        db.close()
      }
      const splitting = ["sh", "-c", "joined=\"$*\"; ORC_HOME='" + far + "' eval \"exec \\\"$0\\\" '" + binPath + "' $joined\"", process.execPath]
      const farResult = Schema.decodeUnknownSync(RunnerRun)(await resultJson(fixture, "task-2", ["--", ...splitting]))
      expect(farResult.result.run).toEqual({ id: "run-far", status: "succeeded", prLink: "https://github.com/avi2d/orc/pull/2", endReason: null })
    })
  }, runnerTimeout)

  test("two homes sharing one far runner queue separately and read their own runs instead of seeing each other's", async () => {
    await withFixture(async (fixture) => {
      const homeA = fixture.home
      const homeB = join(fixture.dir, "home-b")
      const far = join(fixture.dir, "far-home")
      await mkdir(join(homeB, "backlog"), { recursive: true })
      await mkdir(far, { recursive: true })
      await writeFile(join(homeB, "backlog", "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { linux: fixture.checkout } }] }))
      await fakeQuota(fixture)
      const machineThroughFar = [process.execPath, binPath, "runner", "start", "--", ...orcThere(far)]
      await writeTwoHomeDispatches(homeA, homeB, machineThroughFar)
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
      await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--machine", "linux"])
      await orcOk(fixture, ["beat"])
      const addB = await runOrc(fixture, ["backlog", "add", "orc", "task.md", "--machine", "linux"], { ORC_HOME: homeB })
      if (addB.exitCode !== 0) {
        throw new Error("home-b add exited " + addB.exitCode + ": " + addB.stderr)
      }
      const beatB = await runOrc(fixture, ["beat"], { ORC_HOME: homeB })
      if (beatB.exitCode !== 0) {
        throw new Error("home-b beat exited " + beatB.exitCode + ": " + beatB.stderr)
      }
      expect(beatB.stdout).toContain("started task-1")
      expect(beatB.stdout).not.toContain("already")
      const added = await waitForAddedTasks(fixture)
      const labelA = homeA + " task-1"
      const labelB = homeB + " task-1"
      expect(added.some((line) => line.startsWith(labelA + " orc "))).toBe(true)
      expect(added.some((line) => line.startsWith(labelB + " orc "))).toBe(true)
      const queueA = await runOrc(fixture, ["runner", "queue"], { ORC_HOME: far }, JSON.stringify({ task: "task-1", checkout: fixture.checkout, provider: "acme", body: "# x\n", token: "tokenA123", expiresAt: "2027-01-01T00:00:00.000Z", label: labelA }))
      expect(queueA.exitCode).toBe(0)
      const queueB = await runOrc(fixture, ["runner", "queue"], { ORC_HOME: far }, JSON.stringify({ task: "task-1", checkout: fixture.checkout, provider: "acme", body: "# x\n", token: "tokenB123", expiresAt: "2027-01-01T00:00:00.000Z", label: labelB }))
      expect(queueB.exitCode).toBe(0)
      expect(queueB.stdout).toContain("queued task-1")
      const tokenFileA = join(far, "runner", "tokens", "label-" + encodeURIComponent(labelA), "token")
      const tokenFileB = join(far, "runner", "tokens", "label-" + encodeURIComponent(labelB), "token")
      expect(await readFile(tokenFileA, "utf8")).toBe("tokenA123")
      expect(await readFile(tokenFileB, "utf8")).toBe("tokenB123")
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({
        tasks: {
          "77": { id: 77, label: labelA, group: "orc", path: fixture.checkout, status: { Running: { start: "2026-10-28T02:36:41.331824562+03:00" } } },
          "78": { id: 78, label: labelB, group: "orc", path: fixture.checkout, status: { Running: { start: "2026-10-28T02:36:41.331824562+03:00" } } }
        },
        groups: {}
      }))
      const renewB = await runOrc(fixture, ["runner", "renew", "--", ...orcThere(far)], { ORC_HOME: homeB }, JSON.stringify({ task: "task-1", token: "tokenB456", expiresAt: "2027-01-01T00:00:00.000Z", label: labelB }))
      expect(renewB.exitCode).toBe(0)
      expect(await readFile(tokenFileA, "utf8")).toBe("tokenA123")
      expect(await readFile(tokenFileB, "utf8")).toBe("tokenB456")
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({
        tasks: {
          "77": { id: 77, label: labelA, group: "orc", path: fixture.checkout, status: { Done: { start: "2026-10-28T02:36:39.176448491+03:00", end: "2026-10-28T02:36:39.489650573+03:00", result: "Success" } } },
          "78": { id: 78, label: labelB, group: "orc", path: fixture.checkout, status: { Done: { start: "2026-10-28T02:36:39.500714478+03:00", end: "2026-10-28T02:36:39.813536573+03:00", result: { Failed: 3 } } } }
        },
        groups: {}
      }))
      const RunnerStatus = Schema.Struct({ result: Schema.Struct({ status: Schema.String, pueueTask: Schema.Finite }) })
      const resultA = Schema.decodeUnknownSync(RunnerStatus)(JSON.parse(await orcOk(fixture, ["runner", "result", "task-1", "--label", labelA, "--json", "--", ...orcThere(far)], { ORC_HOME: homeA })))
      const resultB = Schema.decodeUnknownSync(RunnerStatus)(JSON.parse(await orcOk(fixture, ["runner", "result", "task-1", "--label", labelB, "--json", "--", ...orcThere(far)], { ORC_HOME: homeB })))
      expect(resultA.result.status).toBe("succeeded")
      expect(resultA.result.pueueTask).toBe(77)
      expect(resultB.result.status).toBe("failed")
      expect(resultB.result.pueueTask).toBe(78)
    })
  }, runnerTimeout)
})

describe("orc runner queue for a kind none account", () => {
  const bareRunArgs = (fixture: Fixture, task: string, provider: string): Array<string> => [
    "--group", "orc", "--label", fixture.home + " " + task, "--working-directory", fixture.checkout, "--print-task-id", "--escape", "--",
    process.execPath, binPath, "run", join(fixture.home, "runner", task + ".md"), "--branch", "orc/" + task,
    "--sandbox", "none", "--provider", provider
  ]

  test("queues a request with no token and no --token-file instead of holding a token", async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.home, "config.json"), JSON.stringify({
        providers: [{ id: "acme", credential: "package", packages: ["git:example.test/acme/tools@v1.2.0"], env: { ACME_ACCOUNT_DIR: "/accounts/main" } }],
        models: { implementer: "acme/coder-3", fixer: "acme/coder-3" }
      }))
      const result = await queueWith(fixture, { task: "task-9", checkout: fixture.checkout, provider: "acme", body: "# x\n" })
      expect(result.exitCode).toBe(0)
      expect((await readFile(join(fixture.pueue, "add-args"), "utf8")).split("\n").slice(0, -1)).toEqual(bareRunArgs(fixture, "task-9", "acme"))
      expect(await Bun.file(join(fixture.home, "runner", "tokens", "task-9", "token")).exists()).toBe(false)
    })
  }, runnerTimeout)

  test("refuses the queue while the orc config is invalid instead of starting the run", async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.home, "config.json"), JSON.stringify({ providers: [{ id: "acme", credential: "bogus" }] }))
      const result = await queueWith(fixture, { task: "task-9", checkout: fixture.checkout, provider: "acme", token: "tokenA123", expiresAt: "2027-01-01T00:00:00.000Z", body: "# x\n" })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain(join(fixture.home, "config.json"))
      expect(await Bun.file(join(fixture.home, "runner", "tokens", "task-9", "token")).exists()).toBe(false)
    })
  }, runnerTimeout)

  test("queues the run with --token-file instead of dropping the account token file", async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.home, "config.json"), JSON.stringify({
        providers: [{ id: "acme", credential: "token-file", tokenFile: { env: "ACME_TOKEN_FILE" } }]
      }))
      const result = await queueWith(fixture, { task: "task-9", checkout: fixture.checkout, provider: "acme", tokenFile: mainToken, body: "# x\n" })
      expect(result.exitCode).toBe(0)
      expect((await readFile(join(fixture.pueue, "add-args"), "utf8")).split("\n").slice(0, -1)).toEqual([...bareRunArgs(fixture, "task-9", "acme"), "--token-file", mainToken])
    })
  }, runnerTimeout)

  test("a beat start for a kind none account queues with no --token-file and renews nothing", async () => {
    await withFixture(async (fixture) => {
      await fakeQuota(fixture)
      await writeFile(join(fixture.home, "backlog", "dispatch.json"), JSON.stringify({
        machines: [{ name: "linux", slots: 1, start: [process.execPath, binPath, "runner", "start"] }],
        quota: { provider: "acme", command: ["orc-quota"], accounts: [{ name: "main", kind: "none" }], floorPercent: 15 }
      }))
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
      await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--machine", "linux"])
      await orcOk(fixture, ["beat"])
      expect(await queuedArgs(fixture)).toEqual(bareRunArgs(fixture, "task-1", "acme"))
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({
        tasks: {
          "77": {
            id: 77,
            label: fixture.home + " task-1",
            group: "orc",
            path: fixture.checkout,
            status: { Running: { start: "2026-10-28T02:36:39.176448491+03:00" } }
          }
        },
        groups: {}
      }))
      const second = await orcOk(fixture, ["beat"])
      expect(second).not.toContain("renew")
      expect(await Bun.file(join(fixture.home, "runner", "tokens", "task-1", "token")).exists()).toBe(false)
    })
  }, runnerTimeout)
})
