import { describe, expect, test } from "bun:test"
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Schema } from "effect"
import { openDatabase, recordRun } from "../../packages/run/src/entities/run-history/index"
import { binPath, fakeQuota, type Fixture, mainToken, type OrcResult, orcOk, orcThere, queuedArgs, queuedEnv, resultJson, RunnerRun, runnerTimeout, runOrc, startWaitMillis, withFixture } from "./runner-helpers"

const queueWith = (fixture: Fixture, request: object, env: Record<string, string> = {}): Promise<OrcResult> =>
  runOrc(fixture, ["runner", "queue"], env, JSON.stringify(request))

const writeMachine = async (fixture: Fixture, start: ReadonlyArray<string>): Promise<void> => {
  await writeFile(join(fixture.home, "backlog", "dispatch.json"), JSON.stringify({
    machines: [{ name: "linux", slots: 1, start }],
    quota: { provider: "acme", command: ["orc-quota"], accounts: [{ name: "main", tokenFile: mainToken }], floorPercent: 15 }
  }))
}

const writeMode = (fixture: Fixture, mode: string): Promise<void> =>
  writeFile(join(fixture.home, "backlog", "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { linux: fixture.checkout }, mode }] }))

const beatStarts = async (fixture: Fixture, start: ReadonlyArray<string>, kind: ReadonlyArray<string> = []): Promise<ReadonlyArray<string> | null> => {
  await fakeQuota(fixture)
  await writeMachine(fixture, start)
  await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
  await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--machine", "linux", ...kind])
  await orcOk(fixture, ["beat"])
  return queuedArgs(fixture)
}

const pueueAddFor = (home: string, checkout: string): ReadonlyArray<string> => [
  "--group", "orc", "--label", home + " orc-1", "--working-directory", checkout, "--print-task-id", "--escape", "--",
  process.execPath, binPath, "run", join(home, "runner", "orc-1.md"), "--branch", "orc/orc-1",
  "--sandbox", "none", "--provider", "acme", "--token-file", mainToken
]

describe("orc runner start", () => {
  test("the beat's start hands the task to pueue in group orc instead of running orc itself", async () => {
    await withFixture(async (fixture) => {
      const added = await beatStarts(fixture, [process.execPath, binPath, "runner", "start"])
      expect(added).toEqual(pueueAddFor(fixture.home, fixture.checkout))
      expect(await queuedEnv(fixture)).toBe(fixture.home)
      expect(await readFile(join(fixture.home, "runner", "orc-1.md"), "utf8")).toBe(await readFile(join(fixture.dir, "task.md"), "utf8"))
    })
  }, runnerTimeout)

  test("a scout's start queues orc run with --kind scout instead of a ship run", async () => {
    await withFixture(async (fixture) => {
      const added = await beatStarts(fixture, [process.execPath, binPath, "runner", "start"], ["--kind", "scout"])
      const ship = pueueAddFor(fixture.home, fixture.checkout)
      expect(added).toEqual([...ship.slice(0, -2), "--kind", "scout", ...ship.slice(-2)])
    })
  }, runnerTimeout)

  test("a direct-PR project's ship task queues orc run with --delivery direct-PR instead of a no-mistakes run", async () => {
    await withFixture(async (fixture) => {
      await writeMode(fixture, "direct-PR")
      const added = await beatStarts(fixture, [process.execPath, binPath, "runner", "start"])
      const ship = pueueAddFor(fixture.home, fixture.checkout)
      expect(added).toEqual([...ship.slice(0, -2), "--delivery", "direct-PR", ...ship.slice(-2)])
    })
  }, runnerTimeout)

  test("a prod-only project's unmarked ship task queues a no-mistakes run instead of a direct PR", async () => {
    await withFixture(async (fixture) => {
      await writeMode(fixture, "no-mistakes-prod-only")
      expect(await beatStarts(fixture, [process.execPath, binPath, "runner", "start"])).toEqual(pueueAddFor(fixture.home, fixture.checkout))
    })
  }, runnerTimeout)

  test("a prod-only project's internal ship task queues --delivery direct-PR instead of a no-mistakes run", async () => {
    await withFixture(async (fixture) => {
      await writeMode(fixture, "no-mistakes-prod-only")
      const added = await beatStarts(fixture, [process.execPath, binPath, "runner", "start"], ["--internal"])
      const ship = pueueAddFor(fixture.home, fixture.checkout)
      expect(added).toEqual([...ship.slice(0, -2), "--delivery", "direct-PR", ...ship.slice(-2)])
    })
  }, runnerTimeout)

  test("an internal mark on a no-mistakes project's task still queues a no-mistakes run instead of a direct PR", async () => {
    await withFixture(async (fixture) => {
      await writeMode(fixture, "no-mistakes")
      expect(await beatStarts(fixture, [process.execPath, binPath, "runner", "start"], ["--internal"])).toEqual(pueueAddFor(fixture.home, fixture.checkout))
    })
  }, runnerTimeout)

  test("an unknown mode is refused naming the project instead of starting the task", async () => {
    await withFixture(async (fixture) => {
      await writeMachine(fixture, ["true"])
      await writeMode(fixture, "yolo")
      const added = await runOrc(fixture, ["backlog", "add", "orc", "task.md"])
      expect(added.exitCode).not.toBe(0)
      expect(added.stderr).toContain("the project orc names the mode yolo, which is not no-mistakes, direct-PR or no-mistakes-prod-only")
    })
  }, runnerTimeout)

  test("a start through a command queues on the far side's home, not the dispatcher's", async () => {
    await withFixture(async (fixture) => {
      const far = join(fixture.dir, "far-home")
      const added = await beatStarts(fixture, [process.execPath, binPath, "runner", "start", "--", ...orcThere(far)])
      const label = fixture.home + " orc-1"
      expect(added).toEqual([
        "--group", "orc", "--label", label, "--working-directory", fixture.checkout, "--print-task-id", "--escape", "--",
        process.execPath, binPath, "run", join(far, "runner", "label-" + encodeURIComponent(label) + ".md"), "--branch", "orc/orc-1",
        "--sandbox", "none", "--provider", "acme", "--token-file", mainToken
      ])
      expect(await queuedEnv(fixture)).toBe(far)
      expect(await readFile(join(far, "runner", "label-" + encodeURIComponent(label) + ".md"), "utf8")).toBe(await readFile(join(fixture.dir, "task.md"), "utf8"))
    })
  }, runnerTimeout)

  test("a beat closes a far-home run through its machine with the far run's PR instead of leaving it started", async () => {
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
            label: fixture.home + " orc-1",
            group: "orc",
            path: fixture.checkout,
            status: { Done: { start: "2026-10-28T02:36:39.176448491+03:00", end: "2026-10-28T02:36:39.489650573+03:00", result: "Success" } }
          }
        },
        groups: {}
      }))
      const db = await Effect.runPromise(openDatabase(far).pipe(Effect.provide(BunServices.layer)))
      try {
        Effect.runSync(recordRun(db, {
          id: "run-1",
          project: fixture.checkout,
          branch: "orc/orc-1",
          taskFile: "task.md",
          status: "succeeded",
          started: "2026-10-27T23:36:39.200Z",
          ended: "2026-10-27T23:36:39.400Z",
          prLink: "https://github.com/example/orc/pull/3"
        }))
      } finally {
        db.close()
      }
      const second = await orcOk(fixture, ["beat"])
      expect(second).toContain("closed orc-1 done on linux: pueue task 77 succeeded, PR https://github.com/example/orc/pull/3")
      const backlog: unknown = JSON.parse(await orcOk(fixture, ["backlog", "--json"]))
      expect(backlog).toMatchObject({ tasks: [{ id: "orc-1", status: "closed", outcome: "done", pr: "https://github.com/example/orc/pull/3" }] })
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
      expect(document.result.run).toEqual({ id: "run-root", status: "succeeded", prLink: "https://github.com/avi2d/orc/pull/9", endReason: null, openQuestions: [] })
    })
  }, runnerTimeout)

  test("a task pueue still runs in group orc is not queued twice", async () => {
    await withFixture(async (fixture) => {
      const result = await queueWith(fixture, { task: "task-6", checkout: fixture.checkout, provider: "acme", tokenFile: mainToken, body: "# Again\n" })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("task-6 is already pueue task 660 in group orc\n")
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

