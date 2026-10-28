import { describe, expect, test } from "bun:test"
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { openDatabase, recordRun } from "../../packages/run/src/run-history"

const binPath = new URL("../../packages/run/src/bin.ts", import.meta.url).pathname
const pueueFixtures = new URL("../fixtures/pueue", import.meta.url).pathname

const startWaitMillis = 10_000
const runnerTimeout = 60_000

interface Fixture {
  readonly dir: string
  readonly home: string
  readonly checkout: string
  readonly pueue: string
  readonly env: Record<string, string>
}

interface OrcResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

const fakePueue = [
  "#!/bin/sh",
  "case \"$1\" in",
  "  status) cat \"$PUEUE_STATE/status.json\" ;;",
  "  log) if [ -f \"$PUEUE_STATE/log-$2.json\" ]; then cat \"$PUEUE_STATE/log-$2.json\"; else printf '{\"%s\":{\"output\":\"\"}}' \"$2\"; fi ;;",
  "  add)",
  "    if [ -n \"$PUEUE_ADD_REFUSES\" ]; then echo \"$PUEUE_ADD_REFUSES\" >&2; exit 1; fi",
  "    shift; printf '%s\\n' \"$@\" > \"$PUEUE_STATE/add-args.tmp\"; mv \"$PUEUE_STATE/add-args.tmp\" \"$PUEUE_STATE/add-args\"; echo 77 ;;",
  "  *) echo \"fake pueue has no $1\" >&2; exit 2 ;;",
  "esac",
  ""
].join("\n")

const withFixture = async (body: (fixture: Fixture) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-runner-e2e-"))
  try {
    const bin = join(dir, "bin")
    const pueue = join(dir, "pueue")
    const home = join(dir, "home")
    const checkout = join(dir, "winbox-orc")
    await mkdir(bin)
    await mkdir(join(home, "backlog"), { recursive: true })
    await mkdir(checkout)
    await cp(pueueFixtures, pueue, { recursive: true })
    await writeFile(join(bin, "pueue"), fakePueue)
    await chmod(join(bin, "pueue"), 0o755)
    await writeFile(join(dir, "task.md"), "# Do the thing\n\nWith a body that holds 'quotes' and $dollars.\n")
    await writeFile(join(home, "backlog", "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { winbox: checkout } }] }))
    await body({ dir, home, checkout, pueue, env: { ORC_HOME: home, PUEUE_STATE: pueue, PATH: bin + ":" + (process.env.PATH ?? "") } })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const runOrc = async (
  fixture: Fixture,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
  stdin: string | null = null
): Promise<OrcResult> => {
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

const queueWith = (fixture: Fixture, request: object, env: Record<string, string> = {}): Promise<OrcResult> =>
  runOrc(fixture, ["runner", "queue"], env, JSON.stringify(request))

const resultJson = async (fixture: Fixture, task: string, through: ReadonlyArray<string> = []): Promise<unknown> =>
  JSON.parse(await orcOk(fixture, ["runner", "result", task, "--json", ...through]))

const writeMachine = async (fixture: Fixture, start: ReadonlyArray<string>): Promise<void> => {
  await writeFile(join(fixture.home, "backlog", "dispatch.json"), JSON.stringify({
    machines: [{ name: "winbox", slots: 1, start }],
    quota: { accounts: ["main"], floorPercent: 15 }
  }))
}

const fakeClauth = async (fixture: Fixture): Promise<void> => {
  const status = { schema: 2, profiles: [{ name: "main", auth_status: "ok", fetch_status: "Fresh", stale: false, windows: [{ label: "5h", utilization_pct: 10 }, { label: "7d", utilization_pct: 20 }] }] }
  await writeFile(join(fixture.dir, "bin", "clauth"), "#!/bin/sh\ncat <<'J'\n" + JSON.stringify(status) + "\nJ\n")
  await chmod(join(fixture.dir, "bin", "clauth"), 0o755)
}

const queuedArgs = async (fixture: Fixture): Promise<ReadonlyArray<string> | null> => {
  const deadline = Date.now() + startWaitMillis
  while (Date.now() < deadline) {
    const text = await readFile(join(fixture.pueue, "add-args"), "utf8").catch(() => null)
    if (text !== null) {
      return text.split("\n").slice(0, -1)
    }
    await Bun.sleep(20)
  }
  return null
}

const beatStarts = async (fixture: Fixture, start: ReadonlyArray<string>): Promise<ReadonlyArray<string> | null> => {
  await fakeClauth(fixture)
  await writeMachine(fixture, start)
  await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
  await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--machine", "winbox"])
  await orcOk(fixture, ["beat"])
  return queuedArgs(fixture)
}

const pueueAddFor = (home: string, checkout: string): ReadonlyArray<string> => [
  "--group", "orc", "--label", "task-1", "--working-directory", checkout, "--print-task-id", "--escape", "--",
  process.execPath, binPath, "run", join(home, "runner", "task-1.md"), "--branch", "orc/task-1"
]

const orcThere = (home: string): ReadonlyArray<string> => ["sh", "-c", "ORC_HOME='" + home + "' exec \"$0\" '" + binPath + "' \"$@\"", process.execPath]

describe("orc runner start", () => {
  test("the beat's start hands the task to pueue in group orc instead of running orc itself", async () => {
    await withFixture(async (fixture) => {
      const added = await beatStarts(fixture, [process.execPath, binPath, "runner", "start"])
      expect(added).toEqual(pueueAddFor(fixture.home, fixture.checkout))
      expect(await readFile(join(fixture.home, "runner", "task-1.md"), "utf8")).toBe(await readFile(join(fixture.dir, "task.md"), "utf8"))
    })
  }, runnerTimeout)

  test("a start through a command queues on the far side's home, not the dispatcher's", async () => {
    await withFixture(async (fixture) => {
      const far = join(fixture.dir, "far-home")
      const added = await beatStarts(fixture, [process.execPath, binPath, "runner", "start", "--", ...orcThere(far)])
      expect(added).toEqual(pueueAddFor(far, fixture.checkout))
      expect(await readFile(join(far, "runner", "task-1.md"), "utf8")).toBe(await readFile(join(fixture.dir, "task.md"), "utf8"))
    })
  }, runnerTimeout)

  test("a task pueue already holds in group orc is not queued twice", async () => {
    await withFixture(async (fixture) => {
      const result = await queueWith(fixture, { task: "task-1", checkout: fixture.checkout, body: "# Again\n" })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("task-1 is already pueue task 655 in group orc\n")
      expect(await readFile(join(fixture.pueue, "add-args"), "utf8").catch(() => null)).toBeNull()
    })
  }, runnerTimeout)

  test("a checkout missing on the machine is refused before pueue is asked", async () => {
    await withFixture(async (fixture) => {
      const result = await queueWith(fixture, { task: "task-9", checkout: join(fixture.dir, "nowhere"), body: "# x\n" })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toBe("orc: the checkout " + join(fixture.dir, "nowhere") + " is no folder on this machine\n")
      expect(await readFile(join(fixture.pueue, "add-args"), "utf8").catch(() => null)).toBeNull()
    })
  }, runnerTimeout)

  test("a missing orc group fails the start with pueue's own words instead of exiting clean", async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
      const refusal = "Group orc doesn't exists. Use one of these: [\"default\"]"
      const result = await queueWith(fixture, { task: "task-9", checkout: fixture.checkout, body: "# x\n" }, { PUEUE_ADD_REFUSES: refusal })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toBe("orc: pueue add exited 1: " + refusal + "\n")
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
        { schema: "orc.runner.v1", result: { task: "task-1", status: "succeeded", pueueTask: 655, run: null, output: ["hello"], started: "2026-10-28T02:36:39.176448491+03:00", ended: "2026-10-28T02:36:39.489650573+03:00" } },
        { schema: "orc.runner.v1", result: { task: "task-2", status: "failed", pueueTask: 656, run: null, output: [], started: "2026-10-28T02:36:39.500714478+03:00", ended: "2026-10-28T02:36:39.813373536+03:00", reason: "orc exited 3" } },
        { schema: "orc.runner.v1", result: { task: "task-3", status: "failed", pueueTask: 657, run: null, output: [], started: "2026-10-28T02:36:41.331824562+03:00", ended: "2026-10-28T02:36:42.246702792+03:00", reason: "the run was killed" } },
        { schema: "orc.runner.v1", result: { task: "task-4", status: "queued", pueueTask: 658, run: null, output: [] } },
        { schema: "orc.runner.v1", result: { task: "task-5", status: "stashed", pueueTask: 659, run: null, output: [] } },
        { schema: "orc.runner.v1", result: { task: "task-6", status: "running", pueueTask: 660, run: null, output: [], started: "2026-10-28T02:36:41.331824562+03:00" } },
        { schema: "orc.runner.v1", result: { task: "task-7", status: "unknown" } }
      ])
    })
  }, runnerTimeout)

  test("names the orc run on the task's branch with its PR, not just pueue's exit", async () => {
    await withFixture(async (fixture) => {
      const db = await Effect.runPromise(openDatabase(fixture.home).pipe(Effect.provide(BunServices.layer)))
      try {
        Effect.runSync(recordRun(db, {
          id: "run-1",
          project: "orc",
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
        "last output:",
        "  hello",
        ""
      ].join("\n"))
    })
  }, runnerTimeout)

  test("a result read through a command is the far side's result, not the reader's", async () => {
    await withFixture(async (fixture) => {
      const near = join(fixture.dir, "near-home")
      expect(await resultJson(fixture, "task-2", ["--", ...orcThere(fixture.home)])).toEqual(await resultJson(fixture, "task-2"))
      expect(await orcOk(fixture, ["runner", "result", "task-2", "--", ...orcThere(fixture.home)], { ORC_HOME: near })).toBe(
        "task-2: failed as pueue task 656, 2026-10-28T02:36:39.500714478+03:00 to 2026-10-28T02:36:39.813373536+03:00: orc exited 3\norc holds no run on orc/task-2\n"
      )
    })
  }, runnerTimeout)
})
