import { describe, expect, test } from "bun:test"
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

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const beatActions = (text: string): ReadonlyArray<{ readonly kind?: unknown; readonly task?: unknown; readonly note?: unknown }> => {
  const document: unknown = JSON.parse(text)
  if (typeof document !== "object" || document === null || !("actions" in document) || !Array.isArray(document.actions)) {
    throw new Error("orc beat --json printed no action list: " + text)
  }
  return document.actions as ReadonlyArray<{ readonly kind?: unknown; readonly task?: unknown; readonly note?: unknown }>
}

const startedLines = async (fixture: Fixture): Promise<ReadonlyArray<string>> =>
  (await readFile(fixture.startLog, "utf8")).split("\n").filter((line) => line !== "").sort()

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

const taskIds = (count: number): ReadonlyArray<string> => Array.from({ length: count }, (_, index) => "task-" + (index + 1))

describe("orc beat", () => {
  test("two beats on one backlog start each task once instead of twice", async () => {
    await withFixture({ mac: 50, winbox: 50, floorPercent: 15 }, async (fixture) => {
      for (let round = 0; round < raceRounds; round += 1) {
        await addTasks(fixture, 3, (index) => index === 0 ? "winbox" : null)
        await raceTwoBeats(fixture)
      }
      const started = (await startedLines(fixture)).map((line) => line.split(" ")[0])
      expect(started).toEqual([...taskIds(3 * raceRounds)].sort())
      expect((await backlogTasks(fixture)).map((task) => task.status)).toEqual(taskIds(3 * raceRounds).map(() => "started"))
    })
  }, beatTimeout)

  test("two beats racing for one free slot never fill it twice", async () => {
    await withFixture({ mac: 1, winbox: 0, floorPercent: 15 }, async (fixture) => {
      await addTasks(fixture, 2 * raceRounds)
      for (let round = 1; round <= raceRounds; round += 1) {
        await raceTwoBeats(fixture)
        expect((await startedLines(fixture)).length).toBeLessThanOrEqual(round)
        await orcOk(fixture, ["beat"])
        expect(await startedLines(fixture)).toHaveLength(round)
        const running = (await backlogTasks(fixture)).filter((task) => task.status === "started")
        expect(running).toHaveLength(1)
        await orcOk(fixture, ["backlog", "close", running[0]?.id ?? "", "done"])
      }
    })
  }, beatTimeout)

  test("a task marked for a machine runs only there instead of on the machine with more room", async () => {
    await withFixture({ mac: 20, winbox: 1, floorPercent: 15 }, async (fixture) => {
      await addTasks(fixture, 3, (index) => index < 2 ? "winbox" : null)
      expect(await orcOk(fixture, ["beat"])).toContain("waits task-2: winbox has no room")
      expect(await startedLines(fixture)).toEqual(["task-1 winbox", "task-3 mac"])
      await orcOk(fixture, ["backlog", "close", "task-1", "done"])
      await orcOk(fixture, ["beat"])
      expect(await startedLines(fixture)).toEqual(["task-1 winbox", "task-2 winbox", "task-3 mac"])
    })
  }, beatTimeout)

  test("a runner that closes before the start command exits leaves the task closed failed instead of stuck started", async () => {
    await withFixture({ mac: 1, winbox: 0, floorPercent: 15 }, async (fixture) => {
      const closeFirst = ["sh", "-c", "\"" + process.execPath + "\" \"" + binPath + "\" backlog close \"$ORC_TASK_ID\" failed"]
      await writeFile(join(fixture.dir, "home", "backlog", "dispatch.json"), JSON.stringify({
        machines: [{ name: "mac", slots: 1, start: closeFirst }, { name: "winbox", slots: 0, start: ["true"] }],
        quota: { accounts: ["main"], floorPercent: 15 }
      }))
      await addTasks(fixture, 1)
      expect(await orcOk(fixture, ["beat"])).toContain("started task-1")
      const document: unknown = JSON.parse(await orcOk(fixture, ["backlog", "--json"]))
      if (typeof document !== "object" || document === null || !("tasks" in document) || !Array.isArray(document.tasks)) {
        throw new Error("orc backlog --json printed no task list")
      }
      const task = document.tasks[0] as { readonly status?: unknown; readonly outcome?: unknown }
      expect(task.status).toBe("closed")
      expect(task.outcome).toBe("failed")
    })
  }, beatTimeout)

  test("a start command that leaves a child behind still reports started at once and leaves the child running", async () => {
    await withFixture({ mac: 1, winbox: 0, floorPercent: 15 }, async (fixture) => {
      const pidFile = join(fixture.dir, "child.pid")
      const lingering = ["sh", "-c", "sleep 30 & echo $! > '" + pidFile + "'; echo handed-off"]
      await writeFile(join(fixture.dir, "home", "backlog", "dispatch.json"), JSON.stringify({
        machines: [{ name: "mac", slots: 1, start: lingering }, { name: "winbox", slots: 0, start: ["true"] }],
        quota: { accounts: ["main"], floorPercent: 15 }
      }))
      await addTasks(fixture, 1)
      const before = Date.now()
      expect(await orcOk(fixture, ["beat"])).toContain("started task-1")
      expect(Date.now() - before).toBeLessThan(10_000)
      const pid = Number(await readFile(pidFile, "utf8"))
      expect(Number.isInteger(pid)).toBe(true)
      expect(alive(pid)).toBe(true)
      process.kill(pid)
    })
  }, beatTimeout)

  test("the beat reports the start command's last lines instead of dropping them", async () => {
    await withFixture({ mac: 1, winbox: 0, floorPercent: 15 }, async (fixture) => {
      const noter = ["sh", "-c", "echo \"ready $ORC_TASK_ID\""]
      await writeFile(join(fixture.dir, "home", "backlog", "dispatch.json"), JSON.stringify({
        machines: [{ name: "mac", slots: 1, start: noter }, { name: "winbox", slots: 0, start: ["true"] }],
        quota: { accounts: ["main"], floorPercent: 15 }
      }))
      await addTasks(fixture, 5)
      for (let index = 1; index <= 5; index += 1) {
        const expected = "ready task-" + index
        if (index % 2 === 0) {
          const action = beatActions(await orcOk(fixture, ["beat", "--json"])).find((candidate) => candidate.task === "task-" + index)
          expect(action?.kind).toBe("started")
          expect(action?.note).toBe(expected)
        } else {
          expect(await orcOk(fixture, ["beat"])).toContain("started task-" + index + " on mac with main: " + expected)
        }
      }
    })
    await withFixture({ mac: 5, winbox: 0, floorPercent: 15 }, async (fixture) => {
      const failer = ["sh", "-c", "echo \"no checkout for $ORC_TASK_ID\" >&2; exit 1"]
      await writeFile(join(fixture.dir, "home", "backlog", "dispatch.json"), JSON.stringify({
        machines: [{ name: "mac", slots: 5, start: failer }, { name: "winbox", slots: 0, start: ["true"] }],
        quota: { accounts: ["main"], floorPercent: 15 }
      }))
      await addTasks(fixture, 5)
      await orcOk(fixture, ["beat"])
      const document: unknown = JSON.parse(await orcOk(fixture, ["backlog", "--json"]))
      if (typeof document !== "object" || document === null || !("tasks" in document) || !Array.isArray(document.tasks)) {
        throw new Error("orc backlog --json printed no task list")
      }
      const tasks = document.tasks as ReadonlyArray<{ readonly id?: unknown; readonly status?: unknown; readonly outcome?: unknown; readonly reason?: unknown }>
      for (let index = 1; index <= 5; index += 1) {
        const task = tasks.find((candidate) => candidate.id === "task-" + index)
        expect(task?.status).toBe("closed")
        expect(task?.outcome).toBe("start-failed")
        expect(task?.reason).toContain("no checkout for task-" + index)
      }
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
