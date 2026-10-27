import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const beatTimeout = 120_000
const raceRounds = 4

const binPath = new URL("../../packages/run/src/bin.ts", import.meta.url).pathname

const clauthStatus = {
  schema: 2,
  profiles: [{
    name: "main",
    auth_status: "ok",
    fetch_status: "Fresh",
    stale: false,
    windows: [{ label: "5h", utilization_pct: 10 }, { label: "7d", utilization_pct: 20 }]
  }]
}

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
  env: Record<string, string> = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn([process.execPath, binPath, ...args], {
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

const fakeClauth = (arrivals: string): string =>
  [
    "#!/bin/sh",
    "touch '" + arrivals + "'/$$",
    "while [ \"$(ls '" + arrivals + "' | wc -l)\" -lt \"${CLAUTH_AWAITS:-0}\" ]; do sleep 0.01; done",
    "cat <<'J'",
    JSON.stringify(clauthStatus),
    "J",
    ""
  ].join("\n")

interface FixtureShape {
  readonly mac: number
  readonly winbox: number
  readonly floorPercent: number
}

const withFixture = async (shape: FixtureShape, body: (fixture: Fixture) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-dispatch-e2e-"))
  try {
    const bin = join(dir, "bin")
    const backlog = join(dir, "home", "backlog")
    const startLog = join(dir, "starts.log")
    const arrivals = join(dir, "clauth-arrivals")
    await mkdir(bin, { recursive: true })
    await mkdir(backlog, { recursive: true })
    await mkdir(arrivals)
    await writeFile(join(bin, "clauth"), fakeClauth(arrivals))
    await chmod(join(bin, "clauth"), 0o755)
    const start = ["sh", "-c", "sleep 0.1; echo \"$ORC_TASK_ID $ORC_TASK_MACHINE\" >> '" + startLog + "'"]
    await writeFile(join(backlog, "dispatch.json"), JSON.stringify({
      machines: [{ name: "mac", slots: shape.mac, start }, { name: "winbox", slots: shape.winbox, start }],
      quota: { accounts: ["main"], floorPercent: shape.floorPercent }
    }))
    await writeFile(join(backlog, "projects.json"), JSON.stringify({
      projects: [{ name: "orc", checkouts: { mac: join(dir, "mac-orc"), winbox: join(dir, "winbox-orc") } }]
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
    await orcOk(fixture, ["backlog", "add", "orc", "task.md", ...(pin === null ? [] : ["--machine", pin])])
  }
}

// Both beats read the backlog only after both have asked clauth for quota, so they reach the first task together.
const raceTwoBeats = async (fixture: Fixture): Promise<void> => {
  await rm(fixture.arrivals, { recursive: true, force: true })
  await mkdir(fixture.arrivals)
  await Promise.all([orcOk(fixture, ["beat"], { CLAUTH_AWAITS: "2" }), orcOk(fixture, ["beat"], { CLAUTH_AWAITS: "2" })])
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
    machines: [{ name: "mac", slots: 1, start }, { name: "winbox", slots: 0, start: ["true"] }],
    quota: { accounts: ["main"], floorPercent: 15 }
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

const taskIds = (count: number): ReadonlyArray<string> => Array.from({ length: count }, (_, index) => "task-" + (index + 1))

describe("orc beat", () => {
  test("two beats on one backlog start each task once instead of twice", async () => {
    await withFixture({ mac: 50, winbox: 50, floorPercent: 15 }, async (fixture) => {
      for (let round = 0; round < raceRounds; round += 1) {
        await addTasks(fixture, 3, (index) => index === 0 ? "winbox" : null)
        await raceTwoBeats(fixture)
      }
      const started = (await settledStarts(fixture, 3 * raceRounds)).map((line) => line.split(" ")[0])
      expect(started).toEqual([...taskIds(3 * raceRounds)].sort())
      expect((await backlogTasks(fixture)).map((task) => task.status)).toEqual(taskIds(3 * raceRounds).map(() => "started"))
    })
  }, beatTimeout)

  test("two beats racing for one free slot never fill it twice", async () => {
    await withFixture({ mac: 1, winbox: 0, floorPercent: 15 }, async (fixture) => {
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
    await withFixture({ mac: 20, winbox: 1, floorPercent: 15 }, async (fixture) => {
      await addTasks(fixture, 3, (index) => index < 2 ? "winbox" : null)
      expect(await orcOk(fixture, ["beat"])).toContain("waits task-2: winbox has no room")
      expect(await settledStarts(fixture, 2)).toEqual(["task-1 winbox", "task-3 mac"])
      await orcOk(fixture, ["backlog", "close", "task-1", "done"])
      await orcOk(fixture, ["beat"])
      expect(await settledStarts(fixture, 3)).toEqual(["task-1 winbox", "task-2 winbox", "task-3 mac"])
    })
  }, beatTimeout)

  test("a runner that closes its task at once leaves it closed failed instead of refused as not started", async () => {
    await withFixture({ mac: 1, winbox: 0, floorPercent: 15 }, async (fixture) => {
      await writeMachines(fixture, ["sh", "-c", "\"" + process.execPath + "\" \"" + binPath + "\" backlog close \"$ORC_TASK_ID\" failed"])
      await addTasks(fixture, 1)
      expect(await orcOk(fixture, ["beat"])).toContain("started task-1")
      const task = await eventually(() => backlogTask(fixture, "task-1"), (found) => found?.status === "closed")
      expect(task?.status).toBe("closed")
      expect(task?.outcome).toBe("failed")
    })
  }, beatTimeout)

  test("a start command outlives the end of the beat's process group instead of dying with it", async () => {
    await withFixture({ mac: 1, winbox: 0, floorPercent: 15 }, async (fixture) => {
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
      expect(await eventually(() => readFile(marker, "utf8").catch(() => ""), (text) => text !== "")).toBe("task-1\n")
    })
  }, beatTimeout)

  test("the start command's output goes to the task's log instead of the beat's output", async () => {
    await withFixture({ mac: 1, winbox: 0, floorPercent: 15 }, async (fixture) => {
      await writeMachines(fixture, ["sh", "-c", "echo \"out $ORC_TASK_ID\"; echo \"err $ORC_TASK_ID\" >&2"])
      await addTasks(fixture, 1)
      const log = join(fixture.dir, "home", "backlog", "logs", "task-1.log")
      const output = await orcOk(fixture, ["beat"])
      expect(output).toContain("started task-1 on mac with main, output to " + log)
      expect(output).not.toContain("out task-1")
      expect(await eventually(() => readFile(log, "utf8").catch(() => ""), (text) => text.includes("err"))).toBe("out task-1\nerr task-1\n")
    })
  }, beatTimeout)

  test("a beat with no Claude account above the floor starts nothing", async () => {
    await withFixture({ mac: 4, winbox: 4, floorPercent: 90 }, async (fixture) => {
      await addTasks(fixture, 1)
      expect(await orcOk(fixture, ["beat"])).toContain("waits task-1: no Claude account has room")
      expect(await startedLines(fixture)).toEqual([])
    })
  }, beatTimeout)

  test("adding a task for a project not in the list is refused instead of queued", async () => {
    await withFixture({ mac: 1, winbox: 1, floorPercent: 15 }, async (fixture) => {
      const result = await runOrc(fixture, ["backlog", "add", "web", "task.md"])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("the project web is not in")
    })
  }, beatTimeout)
})
