import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { addTasks, backlogTask, beatTimeout, binPath, eventually, type Fixture, orcOk, quotaConfig, runOrc, settledStarts, startedLines, startSettleMillis, withFixture } from "./dispatch-helpers"

const raceRounds = 4

interface TaskJson {
  readonly id: string
  readonly status: string
}

const isTaskJson = (value: unknown): value is TaskJson =>
  typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" && "status" in value && typeof value.status === "string"

const parseBacklogTasks = (text: string): ReadonlyArray<TaskJson> => {
  const document: unknown = JSON.parse(text)
  if (typeof document !== "object" || document === null || !("tasks" in document) || !Array.isArray(document.tasks)) {
    throw new Error("orc backlog --json printed no task list: " + text)
  }
  const tasks: ReadonlyArray<unknown> = document.tasks
  if (!tasks.every(isTaskJson)) {
    throw new Error("orc backlog --json printed a task with no id or status: " + text)
  }
  return tasks
}

// Both beats read the backlog only after both have run the quota command, so they reach the first task together.
const raceTwoBeats = async (fixture: Fixture): Promise<void> => {
  await rm(fixture.arrivals, { recursive: true, force: true })
  await mkdir(fixture.arrivals)
  await Promise.all([orcOk(fixture, ["beat"], { QUOTA_AWAITS: "2" }), orcOk(fixture, ["beat"], { QUOTA_AWAITS: "2" })])
}

const backlogTasks = async (fixture: Fixture): Promise<ReadonlyArray<TaskJson>> =>
  parseBacklogTasks(await orcOk(fixture, ["backlog", "--json"]))

const writeMachines = async (fixture: Fixture, start: ReadonlyArray<string>): Promise<void> => {
  await writeFile(join(fixture.dir, "home", "backlog", "dispatch.json"), JSON.stringify({
    machines: [{ name: "mac", slots: 1, start }, { name: "linux", slots: 0, start: ["true"] }],
    quota: quotaConfig(15)
  }))
}

const endProcessGroup = (pid: number): void => {
  try {
    process.kill(-pid, "SIGKILL")
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error
    }
  }
}

const taskIds = (count: number): ReadonlyArray<string> => Array.from({ length: count }, (_, index) => "orc-" + (index + 1))

describe("orc beat", () => {
  test("two beats on one backlog start each task once instead of twice", async () => {
    await withFixture({ mac: 50, linux: 50, floorPercent: 15 }, async (fixture) => {
      for (let round = 0; round < raceRounds; round += 1) {
        await addTasks(fixture, 3, (index) => index === 0 ? "linux" : null)
        await raceTwoBeats(fixture)
      }
      const started = (await settledStarts(fixture, 3 * raceRounds)).map((line) => line.split(" ")[0])
      expect(started).toEqual([...taskIds(3 * raceRounds)].sort())
      expect((await backlogTasks(fixture)).map((task) => task.status)).toEqual(taskIds(3 * raceRounds).map(() => "started"))
    })
  }, beatTimeout)

  test("two beats racing for one free slot never fill it twice", async () => {
    await withFixture({ mac: 1, linux: 0, floorPercent: 15 }, async (fixture) => {
      await addTasks(fixture, 2 * raceRounds)
      for (let round = 1; round <= raceRounds; round += 1) {
        await raceTwoBeats(fixture)
        expect((await backlogTasks(fixture)).filter((task) => task.status === "started").length).toBeLessThanOrEqual(1)
        await orcOk(fixture, ["beat"])
        const running = (await backlogTasks(fixture)).filter((task) => task.status === "started")
        expect(running).toHaveLength(1)
        expect(await settledStarts(fixture, round)).toHaveLength(round)
        await orcOk(fixture, ["backlog", "close", running[0]?.id ?? "", "done"])
      }
    })
  }, beatTimeout)

  test("a task marked for a machine runs only there instead of on the machine with more room", async () => {
    await withFixture({ mac: 20, linux: 1, floorPercent: 15 }, async (fixture) => {
      await addTasks(fixture, 3, (index) => index < 2 ? "linux" : null)
      expect(await orcOk(fixture, ["beat"])).toContain("waits orc-2: linux has no room")
      expect(await settledStarts(fixture, 2)).toEqual(["orc-1 linux", "orc-3 mac"])
      await orcOk(fixture, ["backlog", "close", "orc-1", "done"])
      await orcOk(fixture, ["beat"])
      expect(await settledStarts(fixture, 3)).toEqual(["orc-1 linux", "orc-2 linux", "orc-3 mac"])
    })
  }, beatTimeout)

  test("a task with no priority waits while a P1 task takes the slot, and once set to 0 starts before a newer P0 task", async () => {
    await withFixture({ mac: 1, linux: 0, floorPercent: 15 }, async (fixture) => {
      await orcOk(fixture, ["backlog", "add", "orc", "task.md"])
      await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--priority", "1"])
      const first = await orcOk(fixture, ["beat"])
      expect(first).toContain("started orc-2")
      expect(first).toContain("waits orc-1: no priority")
      expect(await settledStarts(fixture, 1)).toEqual(["orc-2 mac"])
      await orcOk(fixture, ["backlog", "priority", "orc-1", "0"])
      await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--priority", "0"])
      await orcOk(fixture, ["backlog", "close", "orc-2", "done"])
      const second = await orcOk(fixture, ["beat"])
      expect(second).toContain("started orc-1")
      expect(second).toContain("waits orc-3: no machine with a checkout of orc has room")
      expect(await settledStarts(fixture, 2)).toEqual(["orc-1 mac", "orc-2 mac"])
    })
  }, beatTimeout)

  test("a runner that closes its task at once leaves it closed failed instead of refused as not started", async () => {
    await withFixture({ mac: 1, linux: 0, floorPercent: 15 }, async (fixture) => {
      await writeMachines(fixture, ["sh", "-c", "\"" + process.execPath + "\" \"" + binPath + "\" backlog close \"$ORC_TASK_ID\" failed"])
      await addTasks(fixture, 1)
      expect(await orcOk(fixture, ["beat"])).toContain("started orc-1")
      const task = await eventually(() => backlogTask(fixture, "orc-1"), (found) => found?.status === "closed")
      expect(task?.status).toBe("closed")
      expect(task?.outcome).toBe("failed")
    })
  }, beatTimeout)

  test("a start command outlives the end of the beat's process group instead of dying with it", async () => {
    await withFixture({ mac: 1, linux: 0, floorPercent: 15 }, async (fixture) => {
      const marker = join(fixture.dir, "handed-on")
      await writeMachines(fixture, ["sh", "-c", "sleep 1; echo \"$ORC_TASK_ID\" > '" + marker + "'"])
      await addTasks(fixture, 1)
      const beat = spawn(process.execPath, [binPath, "beat"], {
        cwd: fixture.dir,
        detached: true,
        stdio: "ignore",
        env: { ...process.env, ...fixture.env }
      })
      const [exitCode] = await once(beat, "exit")
      expect(exitCode).toBe(0)
      endProcessGroup(beat.pid ?? 0)
      expect(await eventually(() => readFile(marker, "utf8").catch(() => ""), (text) => text !== "")).toBe("orc-1\n")
    })
  }, beatTimeout)

  test("the start command's output goes to the task's log instead of the beat's output", async () => {
    await withFixture({ mac: 1, linux: 0, floorPercent: 15 }, async (fixture) => {
      await writeMachines(fixture, ["sh", "-c", "echo \"out $ORC_TASK_ID\"; echo \"err $ORC_TASK_ID\" >&2"])
      await addTasks(fixture, 1)
      const log = join(fixture.dir, "home", "backlog", "logs", "orc-1.log")
      const output = await orcOk(fixture, ["beat"])
      expect(output).toContain("started orc-1 on mac with second, output to " + log)
      expect(output).not.toContain("out orc-1")
      expect(await eventually(() => readFile(log, "utf8").catch(() => ""), (text) => text.includes("err"))).toBe("out orc-1\nerr orc-1\n")
    })
  }, beatTimeout)

  test("the start command gets the roomiest account's token file path instead of the first account's", async () => {
    await withFixture({ mac: 1, linux: 0, floorPercent: 15 }, async (fixture) => {
      const seen = join(fixture.dir, "credential")
      await writeMachines(fixture, ["sh", "-c", "echo \"$ORC_TASK_PROVIDER $ORC_TASK_ACCOUNT $ORC_TASK_TOKEN_FILE\" > '" + seen + "'"])
      await addTasks(fixture, 1)
      await orcOk(fixture, ["beat"])
      expect(await eventually(() => readFile(seen, "utf8").catch(() => ""), (text) => text !== "")).toBe("acme second /secrets/second-token\n")
    })
  }, beatTimeout)

  test("subquo read --json resolves account second instead of naming it unusable, and orc-quota still runs after the switch back", async () => {
    await withFixture({ mac: 1, linux: 0, floorPercent: 15 }, async (fixture) => {
      const observedAt = new Date().toISOString()
      const validUntil = new Date(Date.parse(observedAt) + 600_000).toISOString()
      const fresh = (percentLeft: number) => ({ status: "fresh", observedAt, source: "provider", validUntil, windows: [{ id: "weekly", scope: "all", percentLeft, resetsAt: validUntil }] })
      const snapshot = { version: "subquo.v1", writtenAt: observedAt, accounts: [{ id: "main", provider: "claude", observation: fresh(40) }, { id: "second", provider: "claude", observation: fresh(80) }] }
      await writeFile(join(fixture.dir, "bin", "subquo"), "#!/bin/sh\n[ \"$*\" = 'read --json' ] || exit 3\ncat <<'J'\n" + JSON.stringify(snapshot) + "\nJ\n")
      await chmod(join(fixture.dir, "bin", "subquo"), 0o755)
      const dispatch = join(fixture.dir, "home", "backlog", "dispatch.json")
      const machines = [{ name: "mac", slots: 1, start: ["true"] }, { name: "linux", slots: 0, start: ["true"] }]
      await writeFile(dispatch, JSON.stringify({ machines, quota: { ...quotaConfig(15), command: ["subquo", "read", "--json"] } }))
      await addTasks(fixture, 1)
      expect(await orcOk(fixture, ["beat"])).toContain("second 80% left until " + validUntil + ", floor 15%: runs use second\nroom: mac 0 of 1 busy, linux 0 of 0 busy\nstarted orc-1 on mac with second")
      await writeFile(dispatch, JSON.stringify({ machines: machines.map((machine) => ({ ...machine, slots: machine.name === "mac" ? 2 : 0 })), quota: quotaConfig(15) }))
      await addTasks(fixture, 1)
      expect(await orcOk(fixture, ["beat"])).toMatch(/quota: main 40% left, second 80% left, floor 15%: runs use second\n.*\nstarted orc-2 on mac with second/)
    })
  }, beatTimeout)

  test("subquo's roomiest account starts the run with that account's own provider instead of the quota provider", async () => {
    await withFixture({ mac: 1, linux: 0, floorPercent: 15 }, async (fixture) => {
      const observedAt = new Date().toISOString()
      const validUntil = new Date(Date.parse(observedAt) + 600_000).toISOString()
      const fresh = (percentLeft: number) => ({ status: "fresh", observedAt, source: "provider", validUntil, windows: [{ id: "weekly", scope: "all", percentLeft, resetsAt: validUntil }] })
      const snapshot = { version: "subquo.v1", writtenAt: observedAt, accounts: [{ id: "main", provider: "claude", observation: fresh(40) }, { id: "openai", provider: "codex", observation: fresh(90) }] }
      await writeFile(join(fixture.dir, "bin", "subquo"), "#!/bin/sh\ncat <<'J'\n" + JSON.stringify(snapshot) + "\nJ\n")
      await chmod(join(fixture.dir, "bin", "subquo"), 0o755)
      const seen = join(fixture.dir, "credential")
      const machines = [{ name: "mac", slots: 1, start: ["sh", "-c", "echo \"$ORC_TASK_PROVIDER $ORC_TASK_ACCOUNT\" > '" + seen + "'"] }, { name: "linux", slots: 0, start: ["true"] }]
      const accounts = [{ name: "main", tokenFile: "/secrets/main-token" }, { name: "openai", provider: "codex", tokenFile: "/secrets/openai-token" }]
      await writeFile(join(fixture.dir, "home", "backlog", "dispatch.json"), JSON.stringify({ machines, quota: { ...quotaConfig(15), command: ["subquo", "read", "--json"], accounts } }))
      await addTasks(fixture, 1)
      expect(await orcOk(fixture, ["beat"])).toContain("runs use openai")
      expect(await eventually(() => readFile(seen, "utf8").catch(() => ""), (text) => text !== "")).toBe("codex openai\n")
    })
  }, beatTimeout)

  test("a quota command that fails starts nothing instead of running on an unread account", async () => {
    await withFixture({ mac: 4, linux: 4, floorPercent: 15 }, async (fixture) => {
      await writeFile(join(fixture.dir, "bin", "orc-quota"), "#!/bin/sh\nexit 4\n")
      await addTasks(fixture, 1)
      const output = await orcOk(fixture, ["beat"])
      expect(output).toContain("quota unread: the quota command orc-quota exited 4")
      expect(output).not.toContain("started orc-1")
      expect((await backlogTasks(fixture)).map((task) => task.status)).toEqual(["new"])
    })
  }, beatTimeout)

  test("a beat with no account above the floor starts nothing", async () => {
    await withFixture({ mac: 4, linux: 4, floorPercent: 90 }, async (fixture) => {
      await addTasks(fixture, 1)
      expect(await orcOk(fixture, ["beat"])).toContain("waits orc-1: no account has room")
      expect(await startedLines(fixture)).toEqual([])
    })
  }, beatTimeout)

  test("the beat leaves a task held for the captain new instead of starting it", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      await addTasks(fixture, 1)
      const file = join(fixture.dir, "home", "backlog", "new", "orc-1.md")
      const text = await readFile(file, "utf8")
      await writeFile(file, text.replace("\n---\n", "\nhold_reason: \"which API shape\"\n---\n"))
      const output = await orcOk(fixture, ["beat"])
      await Bun.sleep(startSettleMillis)
      expect([output.includes("started orc-1"), await startedLines(fixture)]).toEqual([false, []])
      expect((await backlogTasks(fixture)).map((task) => task.status)).toEqual(["new"])
    })
  }, beatTimeout)

  test("a task piped to backlog add - lands with its whole body instead of reading a file named -", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      const said = "# Fix the login page\n\nThe button does nothing on a narrow screen.\n"
      const result = await runOrc(fixture, ["backlog", "add", "orc", "-"], {}, said)
      expect(result.stderr).toBe("")
      expect(result.stdout).toBe("added orc-1 for orc\n")
      expect(await backlogTask(fixture, "orc-1")).toMatchObject({ title: "Fix the login page", status: "new" })
      expect(await readFile(join(fixture.dir, "home", "backlog", "new", "orc-1.md"), "utf8")).toEndWith(said)
    })
  }, beatTimeout)

  test("a missing task file is refused as missing instead of with the file system's raw error", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      const result = await runOrc(fixture, ["backlog", "add", "orc", "missing.md"])
      expect([result.exitCode, result.stdout, result.stderr]).toEqual([1, "", "orc: cannot read the task file " + join(await realpath(fixture.dir), "missing.md") + ": the file is missing\n"])
      expect(await backlogTasks(fixture)).toEqual([])
    })
  }, beatTimeout)

  test("tasks piped for two projects are orc-1, orc-2 and website-1 instead of task-1, task-2 and task-3", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      await writeFile(join(fixture.dir, "home", "backlog", "projects.json"), JSON.stringify({
        projects: [{ name: "orc", checkouts: { mac: fixture.dir } }, { name: "website", checkouts: { mac: fixture.dir } }]
      }))
      const added = []
      for (const [project, said] of [["orc", "# One\n"], ["orc", "# One\n"], ["website", "# Two\n"]] as const) {
        added.push((await runOrc(fixture, ["backlog", "add", project, "-"], {}, said)).stdout)
      }
      expect(added).toEqual(["added orc-1 for orc\n", "added orc-2 for orc\n", "added website-1 for website\n"])
    })
  }, beatTimeout)

  test("the next orc task after an old closed task-4 is orc-5 instead of orc-1", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      const closed = join(fixture.dir, "home", "backlog", "closed")
      await mkdir(closed)
      await writeFile(join(closed, "task-4.md"), [
        "---", "id: task-4", "title: Old task", "project: orc", "machine: null", "depends_on: []", "created: 2026-10-27T10:00:00.000Z",
        "beat: beat-1", "taken_for: mac", "account: main", "taken_at: 2026-10-27T10:01:00.000Z",
        "started_at: 2026-10-27T10:02:00.000Z", "start_log: /tmp/task-4.log",
        "outcome: done", "closed_at: 2026-10-27T11:00:00.000Z", "reason: merged", "---", "# Old task", ""
      ].join("\n"))
      expect((await runOrc(fixture, ["backlog", "add", "orc", "-"], {}, "# One\n")).stdout).toBe("added orc-5 for orc\n")
    })
  }, beatTimeout)

  test("an empty pipe to backlog add - is refused instead of adding an untitled task", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      const result = await runOrc(fixture, ["backlog", "add", "orc", "-"], {}, "\n")
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("the task on stdin holds no text")
      expect(await backlogTasks(fixture)).toEqual([])
    })
  }, beatTimeout)

  test("a scout added with --kind shows its kind in backlog and --json, and an unknown kind is refused instead of added as ship", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      expect(await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--kind", "scout"])).toBe("added orc-1 for orc as a scout\n")
      expect(await orcOk(fixture, ["backlog"])).toContain("orc-1 scout orc Do the thing")
      expect(await backlogTask(fixture, "orc-1")).toMatchObject({ kind: "scout" })
      const refused = await runOrc(fixture, ["backlog", "add", "orc", "task.md", "--kind", "deploy"])
      expect({ exitCode: refused.exitCode, stderr: refused.stderr }).toEqual({ exitCode: 1, stderr: expect.stringContaining("the kind deploy is not ship, scout, task, parent or decision") })
      expect((await backlogTasks(fixture)).map((task) => task.id)).toEqual(["orc-1"])
    })
  }, beatTimeout)

  test("adding a task for a project not in the list is refused instead of queued", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      const result = await runOrc(fixture, ["backlog", "add", "web", "task.md"])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("the project web is not in")
    })
  }, beatTimeout)
})
