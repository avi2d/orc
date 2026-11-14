import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const beatTimeout = 120_000
const raceRounds = 4

const binPath = new URL("../../packages/run/src/bin.ts", import.meta.url).pathname

const quotaStatus = {
  schema: "orc.quota.v1",
  accounts: [{ name: "main", remainingPercent: 40 }, { name: "second", remainingPercent: 80 }]
}

const accounts = [{ name: "main", tokenFile: "/secrets/main-token" }, { name: "second", tokenFile: "/secrets/second-token" }]

const quotaConfig = (floorPercent: number) => ({ provider: "acme", command: ["orc-quota", "--json"], accounts, floorPercent })

interface Fixture {
  readonly dir: string
  readonly env: Record<string, string>
  readonly arrivals: string
  readonly startLog: string
}

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

const runOrc = async (
  fixture: Fixture,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
  stdin: string | null = null
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn([process.execPath, binPath, ...args], {
    stdin: stdin === null ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    cwd: fixture.dir,
    env: { ...process.env, ...fixture.env, ...env }
  })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { exitCode, stdout, stderr }
}

const orcOk = async (fixture: Fixture, args: ReadonlyArray<string>, env: Record<string, string> = {}): Promise<string> => {
  const result = await runOrc(fixture, args, env)
  if (result.exitCode !== 0) {
    throw new Error("orc " + args.join(" ") + " exited " + result.exitCode + ": " + result.stderr)
  }
  return result.stdout
}

const fakeQuota = (arrivals: string): string =>
  [
    "#!/bin/sh",
    "[ \"$1\" = --json ] || exit 3",
    "touch '" + arrivals + "'/$$",
    "while [ \"$(ls '" + arrivals + "' | wc -l)\" -lt \"${QUOTA_AWAITS:-0}\" ]; do sleep 0.01; done",
    "cat <<'J'",
    JSON.stringify(quotaStatus),
    "J",
    ""
  ].join("\n")

interface FixtureShape {
  readonly mac: number
  readonly linux: number
  readonly floorPercent: number
}

const withFixture = async (shape: FixtureShape, body: (fixture: Fixture) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-dispatch-e2e-"))
  try {
    const bin = join(dir, "bin")
    const backlog = join(dir, "home", "backlog")
    const startLog = join(dir, "starts.log")
    const arrivals = join(dir, "quota-arrivals")
    await mkdir(bin, { recursive: true })
    await mkdir(backlog, { recursive: true })
    await mkdir(arrivals)
    await writeFile(join(bin, "orc-quota"), fakeQuota(arrivals))
    await chmod(join(bin, "orc-quota"), 0o755)
    const start = ["sh", "-c", "sleep 0.1; echo \"$ORC_TASK_ID $ORC_TASK_MACHINE\" >> '" + startLog + "'"]
    await writeFile(join(backlog, "dispatch.json"), JSON.stringify({
      machines: [{ name: "mac", slots: shape.mac, start }, { name: "linux", slots: shape.linux, start }],
      quota: quotaConfig(shape.floorPercent)
    }))
    await writeFile(join(backlog, "projects.json"), JSON.stringify({
      projects: [{ name: "orc", checkouts: { mac: join(dir, "mac-orc"), linux: join(dir, "linux-orc") } }]
    }))
    await writeFile(join(dir, "task.md"), "# Do the thing\n")
    await writeFile(startLog, "")
    await body({ dir, env: { ORC_HOME: join(dir, "home"), PATH: bin + ":" + (process.env.PATH ?? "") }, arrivals, startLog })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const startSettleMillis = 300
const startWaitMillis = 10_000

const startedLines = async (fixture: Fixture): Promise<ReadonlyArray<string>> =>
  (await readFile(fixture.startLog, "utf8")).split("\n").filter((line) => line !== "").sort()

const eventually = async <A>(read: () => Promise<A>, done: (value: A) => boolean): Promise<A> => {
  const deadline = Date.now() + startWaitMillis
  let value = await read()
  while (!done(value) && Date.now() < deadline) {
    await Bun.sleep(20)
    value = await read()
  }
  return value
}

// The beat does not wait on a start command, so a start shows in the log only after it ran, and a duplicate only after both ran.
const settledStarts = async (fixture: Fixture, count: number): Promise<ReadonlyArray<string>> => {
  await eventually(() => startedLines(fixture), (lines) => lines.length >= count)
  await Bun.sleep(startSettleMillis)
  return startedLines(fixture)
}

const addTasks = async (fixture: Fixture, count: number, machine: (index: number) => string | null = () => null): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    const pin = machine(index)
    await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--priority", "0", ...(pin === null ? [] : ["--machine", pin])])
  }
}

// Both beats read the backlog only after both have run the quota command, so they reach the first task together.
const raceTwoBeats = async (fixture: Fixture): Promise<void> => {
  await rm(fixture.arrivals, { recursive: true, force: true })
  await mkdir(fixture.arrivals)
  await Promise.all([orcOk(fixture, ["beat"], { QUOTA_AWAITS: "2" }), orcOk(fixture, ["beat"], { QUOTA_AWAITS: "2" })])
}

const backlogTasks = async (fixture: Fixture): Promise<ReadonlyArray<TaskJson>> =>
  parseBacklogTasks(await orcOk(fixture, ["backlog", "--json"]))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const backlogTask = async (fixture: Fixture, id: string): Promise<Record<string, unknown> | undefined> => {
  const document: unknown = JSON.parse(await orcOk(fixture, ["backlog", "--json"]))
  if (!isRecord(document) || !Array.isArray(document.tasks)) {
    throw new Error("orc backlog --json printed no task list")
  }
  const tasks: ReadonlyArray<unknown> = document.tasks
  return tasks.filter(isRecord).find((task) => task.id === id)
}

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
      expect(await orcOk(fixture, ["beat"])).toContain("waits orc-1: no acme account has room")
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
      expect({ exitCode: refused.exitCode, stderr: refused.stderr }).toEqual({ exitCode: 1, stderr: expect.stringContaining("the kind deploy is not ship, scout, task or parent") })
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

describe("orc backlog hold and answer", () => {
  test("a held task waits on every beat with its reason and starts only once answered, instead of starting while held", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      await addTasks(fixture, 1)
      expect(await orcOk(fixture, ["backlog", "hold", "orc-1", "--reason", "which API shape"])).toBe("held orc-1: which API shape\n")
      expect(await orcOk(fixture, ["beat"])).toContain("waits orc-1: held for the captain: which API shape")
      expect(await orcOk(fixture, ["beat"])).toContain("waits orc-1: held for the captain: which API shape")
      await Bun.sleep(startSettleMillis)
      expect(await startedLines(fixture)).toEqual([])
      expect(await orcOk(fixture, ["backlog", "answer", "orc-1", "the REST one"])).toBe("answered orc-1, so the beat may start it\n")
      expect(await orcOk(fixture, ["beat"])).toContain("started orc-1")
      expect(await settledStarts(fixture, 1)).toHaveLength(1)
    })
  }, beatTimeout)

  test("a hold whose until date has passed still waits for the answer instead of releasing on the date", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      await addTasks(fixture, 1)
      expect(await orcOk(fixture, ["backlog", "hold", "orc-1", "--reason", "budget", "--until", "2020-01-31"])).toBe("held orc-1: budget, until 2020-01-31\n")
      expect(await orcOk(fixture, ["beat"])).toContain("waits orc-1: held for the captain: budget, until 2020-01-31")
      await Bun.sleep(startSettleMillis)
      expect(await startedLines(fixture)).toEqual([])
    })
  }, beatTimeout)

  test("the backlog shows the reason, the date and the answer word for word instead of a bare new task", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      await addTasks(fixture, 2)
      await orcOk(fixture, ["backlog", "hold", "orc-1", "--reason", "which API shape", "--until", "2026-12-01"])
      await orcOk(fixture, ["backlog", "hold", "orc-2", "--reason", "go or no go"])
      const words = "Go, but:\n  keep the  old \"v1\" path — for now"
      const before = Date.now()
      await orcOk(fixture, ["backlog", "answer", "orc-2", words])
      expect(await backlogTask(fixture, "orc-1")).toMatchObject({ status: "new", hold: { reason: "which API shape", until: "2026-12-01", answer: null } })
      const answered = await backlogTask(fixture, "orc-2")
      expect(answered).toMatchObject({ status: "new", hold: { reason: "go or no go", until: null, answer: { words } } })
      const at = isRecord(answered) && isRecord(answered.hold) && isRecord(answered.hold.answer) ? String(answered.hold.answer.at) : ""
      expect(Date.parse(at)).toBeGreaterThanOrEqual(before - 1_000)
      const board = await orcOk(fixture, ["backlog"])
      expect(board).toContain("orc-1 P0 orc held (which API shape) Do the thing")
      expect(board).toContain("orc-2 P0 orc Do the thing")
    })
  }, beatTimeout)

  test("answer joins the words it is given with one space instead of dropping all but the first", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      await addTasks(fixture, 1)
      await orcOk(fixture, ["backlog", "hold", "orc-1", "--reason", "which API shape"])
      await orcOk(fixture, ["backlog", "answer", "orc-1", "use", "the", "REST", "one"])
      expect(await backlogTask(fixture, "orc-1")).toMatchObject({ hold: { answer: { words: "use the REST one" } } })
    })
  }, beatTimeout)

  test("holding a held task again keeps the first reason instead of replacing it", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      await addTasks(fixture, 1)
      await orcOk(fixture, ["backlog", "hold", "orc-1", "--reason", "first reason", "--until", "2026-12-01"])
      expect(await orcOk(fixture, ["backlog", "hold", "orc-1", "--reason", "second reason"])).toBe("orc-1 is already held: first reason, until 2026-12-01\n")
      expect(await backlogTask(fixture, "orc-1")).toMatchObject({ hold: { reason: "first reason", until: "2026-12-01", answer: null } })
    })
  }, beatTimeout)

  test("a taken task is refused a hold instead of moved back to new under its beat", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      await addTasks(fixture, 1)
      const backlog = join(fixture.dir, "home", "backlog")
      const text = await readFile(join(backlog, "new", "orc-1.md"), "utf8")
      const claimed = "\nbeat: \"beat-1\"\ntaken_for: \"mac\"\naccount: \"main\"\ntaken_at: \"2026-11-02T10:01:00.000Z\"\n---\n"
      await writeFile(join(backlog, "taken", "orc-1.md"), text.replace("\n---\n", claimed))
      await rm(join(backlog, "new", "orc-1.md"))
      const refused = await runOrc(fixture, ["backlog", "hold", "orc-1", "--reason", "wait"])
      expect([refused.exitCode, refused.stderr.trim()]).toEqual([1, "orc: orc-1 is taken, and only a new task is held"])
      expect(await backlogTask(fixture, "orc-1")).toMatchObject({ status: "taken", hold: null })
    })
  }, beatTimeout)

  test("hold refuses an unknown task, a started or closed one and a missing reason instead of writing a hold", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      await addTasks(fixture, 2)
      await orcOk(fixture, ["beat"])
      const refusal = async (args: ReadonlyArray<string>): Promise<readonly [number, string]> => {
        const result = await runOrc(fixture, args)
        return [result.exitCode, result.stderr.split("\n")[0] ?? ""]
      }
      expect(await refusal(["backlog", "hold", "orc-9", "--reason", "why"])).toEqual([1, "orc: the backlog holds no orc-9"])
      expect(await refusal(["backlog", "hold", "orc-1", "--reason", "why"])).toEqual([1, "orc: orc-1 is started, and only a new task is held"])
      await orcOk(fixture, ["backlog", "close", "orc-1", "done"])
      expect(await refusal(["backlog", "hold", "orc-1", "--reason", "why"])).toEqual([1, "orc: orc-1 is closed, and only a new task is held"])
      expect((await refusal(["backlog", "hold", "orc-2"]))[1]).toBe("orc backlog hold takes --reason and why the task waits for the captain")
      expect((await refusal(["backlog", "hold", "orc-2", "--reason", " "]))[1]).toBe("orc backlog hold takes --reason and why the task waits for the captain")
      expect((await refusal(["backlog", "hold", "orc-2", "--reason", "why", "--until", "next week"]))[1]).toBe("orc backlog hold takes a YYYY-MM-DD date after --until, got \"next week\"")
      expect(await backlogTask(fixture, "orc-2")).toMatchObject({ hold: null })
    })
  }, beatTimeout)

  test("answer refuses a task that is not held, or already answered, instead of recording words on it", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      await addTasks(fixture, 1)
      const refused = await runOrc(fixture, ["backlog", "answer", "orc-1", "yes"])
      expect([refused.exitCode, refused.stderr.trim()]).toEqual([1, "orc: orc-1 is not held"])
      await orcOk(fixture, ["backlog", "hold", "orc-1", "--reason", "why"])
      await orcOk(fixture, ["backlog", "answer", "orc-1", "yes"])
      const again = await runOrc(fixture, ["backlog", "answer", "orc-1", "no"])
      expect([again.exitCode, again.stderr.trim()]).toEqual([1, "orc: orc-1 is not held: its hold was answered"])
      expect(await backlogTask(fixture, "orc-1")).toMatchObject({ hold: { answer: { words: "yes" } } })
      expect((await runOrc(fixture, ["backlog", "answer", "orc-1"])).stderr.split("\n")[0]).toBe("orc backlog answer takes a task id and the captain's words")
    })
  }, beatTimeout)
})

const dependsOnLine = async (fixture: Fixture, folder: "new" | "taken", id: string): Promise<string> => {
  const text = await readFile(join(fixture.dir, "home", "backlog", folder, id + ".md"), "utf8")
  return text.split("\n").find((line) => line.startsWith("depends_on:")) ?? ""
}

describe("orc backlog depend", () => {
  test("a new task given dependencies waits for them at the next beat instead of starting", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      await addTasks(fixture, 3)
      expect(await orcOk(fixture, ["backlog", "depend", "orc-1", "--on", "orc-2,orc-3"])).toBe("orc-1 now waits on orc-2, orc-3\n")
      expect(await dependsOnLine(fixture, "new", "orc-1")).toBe("depends_on: [\"orc-2\",\"orc-3\"]")
      expect(await orcOk(fixture, ["backlog", "depend", "orc-1", "--on", "orc-2,orc-3"])).toBe("orc-1 already waits on orc-2, orc-3\n")
      const beat = await orcOk(fixture, ["beat"])
      expect(beat).toContain("waits orc-1: waits on orc-2")
      expect(await backlogTask(fixture, "orc-1")).toMatchObject({ status: "new" })
    })
  }, beatTimeout)

  test("clearing a held task's dependencies keeps its hold instead of dropping it", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      await addTasks(fixture, 2)
      await orcOk(fixture, ["backlog", "depend", "orc-1", "--on", "orc-2"])
      await orcOk(fixture, ["backlog", "hold", "orc-1", "--reason", "which API shape"])
      expect(await orcOk(fixture, ["backlog", "depend", "orc-1", "--clear"])).toBe("orc-1 now waits on no task\n")
      expect(await dependsOnLine(fixture, "new", "orc-1")).toBe("depends_on: []")
      expect(await backlogTask(fixture, "orc-1")).toMatchObject({ status: "new", hold: { reason: "which API shape" } })
    })
  }, beatTimeout)

  test("depend refuses an unknown task, a loop and a taken task instead of writing a dependency", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      await addTasks(fixture, 2)
      const refusal = async (args: ReadonlyArray<string>): Promise<readonly [number, string]> => {
        const result = await runOrc(fixture, args)
        return [result.exitCode, result.stderr.split("\n")[0] ?? ""]
      }
      expect(await refusal(["backlog", "depend", "orc-9", "--clear"])).toEqual([1, "orc: the backlog holds no orc-9"])
      expect(await refusal(["backlog", "depend", "orc-1", "--on", "orc-9"])).toEqual([1, "orc: the backlog holds no task orc-9"])
      expect(await refusal(["backlog", "depend", "orc-1", "--on", "orc-1"])).toEqual([1, "orc: orc-1 cannot wait on itself"])
      await orcOk(fixture, ["backlog", "depend", "orc-2", "--on", "orc-1"])
      expect(await refusal(["backlog", "depend", "orc-1", "--on", "orc-2"])).toEqual([1, "orc: orc-2 already waits on orc-1, so orc-1 waiting on orc-2 would hold both forever"])
      expect((await refusal(["backlog", "depend", "orc-1", "--on", "next"]))[1]).toBe("orc backlog depend takes comma separated task ids after --on, got \"next\"")
      expect((await refusal(["backlog", "depend", "orc-1"]))[1]).toBe("orc backlog depend takes --on and the task ids it waits for, or --clear")
      expect(await dependsOnLine(fixture, "new", "orc-1")).toBe("depends_on: []")
      const backlog = join(fixture.dir, "home", "backlog")
      const text = await readFile(join(backlog, "new", "orc-1.md"), "utf8")
      const claimed = "\nbeat: \"beat-1\"\ntaken_for: \"mac\"\naccount: \"main\"\ntaken_at: \"2026-11-02T10:01:00.000Z\"\n---\n"
      await writeFile(join(backlog, "taken", "orc-1.md"), text.replace("\n---\n", claimed))
      await rm(join(backlog, "new", "orc-1.md"))
      expect(await refusal(["backlog", "depend", "orc-1", "--clear"])).toEqual([1, "orc: orc-1 is taken, and only a new or held task takes other dependencies"])
      expect(await dependsOnLine(fixture, "taken", "orc-1")).toBe("depends_on: []")
    })
  }, beatTimeout)

  test("a task verb on a machine with no backlog names where the backlog lives instead of saying the task is missing", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      const backlog = join(fixture.dir, "home", "backlog")
      await rm(backlog, { recursive: true })
      const refused = await runOrc(fixture, ["backlog", "depend", "orc-1", "--clear"])
      expect([refused.exitCode, refused.stderr.trim()]).toEqual([1, "orc: no backlog at " + backlog + ": the backlog lives on the machine that runs orc beat, so run this command there"])
      expect(await orcOk(fixture, ["backlog"])).toBe("no backlog at " + backlog + ": the backlog lives on the machine that runs orc beat, so run this command there\n")
    })
  }, beatTimeout)
})

