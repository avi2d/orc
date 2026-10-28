import { describe, expect, test } from "bun:test"
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Schema } from "effect"
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
  "  group)",
  "    if [ \"$2\" = \"add\" ]; then printf '%s\\n' \"$@\" > \"$PUEUE_STATE/group-add-args.tmp\"; mv \"$PUEUE_STATE/group-add-args.tmp\" \"$PUEUE_STATE/group-add-args\";",
  "      if [ -f \"$PUEUE_STATE/fail-add\" ]; then echo \"fake pueue cannot add groups\" >&2; exit 1; fi;",
  "      while ! mkdir \"$PUEUE_STATE/group-lock\" 2>/dev/null; do sleep 0.05; done;",
  "      if [ -f \"$PUEUE_STATE/groups.json\" ]; then groups=$(cat \"$PUEUE_STATE/groups.json\");",
  "      else groups='{\"default\":{\"status\":\"Running\",\"parallel_tasks\":1},\"orc\":{\"status\":\"Running\",\"parallel_tasks\":1}}'; fi;",
  "      case \"$groups\" in *\"\\\"$3\\\"\":*) echo \"Group \\\"$3\\\" already exists\" >&2; rmdir \"$PUEUE_STATE/group-lock\"; exit 1 ;; esac;",
  "      if [ -f \"$PUEUE_STATE/groups.json\" ]; then stripped=$(printf '%s' \"$groups\" | sed 's/}$//'); printf '%s,\"%s\":{\"status\":\"Running\",\"parallel_tasks\":1}}' \"$stripped\" \"$3\" > \"$PUEUE_STATE/groups.json\"; fi;",
  "      rmdir \"$PUEUE_STATE/group-lock\";",
  "      if [ -f \"$PUEUE_STATE/race-add\" ]; then echo \"Group \\\"$3\\\" already exists\" >&2; exit 1; fi;",
  "      echo \"Group $3 created\";",
  "    elif [ \"$2\" = \"--json\" ]; then",
  "      if [ -f \"$PUEUE_STATE/group-gate\" ]; then printf '%s\\n' \"$$\" >> \"$PUEUE_STATE/group-reads\"; while [ -f \"$PUEUE_STATE/group-gate\" ]; do sleep 0.05; done; fi;",
  "      if [ -f \"$PUEUE_STATE/groups.json\" ]; then cat \"$PUEUE_STATE/groups.json\";",
  "      else printf '%s' '{\"default\":{\"status\":\"Running\",\"parallel_tasks\":1},\"orc\":{\"status\":\"Running\",\"parallel_tasks\":1}}'; fi;",
  "    else echo \"fake pueue has no group $2\" >&2; exit 2; fi ;;",
  "  add)",
  "    shift; : > \"$PUEUE_STATE/add-args.tmp\"; label=\"\"; group=\"\";",
  "    while [ \"$#\" -gt 0 ]; do case \"$1\" in",
  "      --) printf '%s\\n' \"$1\" >> \"$PUEUE_STATE/add-args.tmp\"; shift; while [ \"$#\" -gt 0 ]; do printf '%s\\n' \"$1\" >> \"$PUEUE_STATE/add-args.tmp\"; shift; done; break ;;",
  "      -w|--working-directory|-g|--group|-l|--label|-d|--delay|-a|--after|-o|--priority) flag=\"$1\"; printf '%s\\n' \"$1\" >> \"$PUEUE_STATE/add-args.tmp\"; shift; if [ \"$#\" -eq 0 ]; then echo \"fake pueue refuses add option without value\" >&2; exit 2; fi; case \"$1\" in -*) echo \"fake pueue refuses add option without value\" >&2; exit 2 ;; esac; case \"$flag\" in -g|--group) group=\"$1\" ;; -l|--label) label=\"$1\" ;; esac; printf '%s\\n' \"$1\" >> \"$PUEUE_STATE/add-args.tmp\"; shift ;;",
  "      -e|--escape|-i|--immediate|--follow|-s|--stashed|-p|--print-task-id) printf '%s\\n' \"$1\" >> \"$PUEUE_STATE/add-args.tmp\"; shift ;;",
  "      -*) echo \"fake pueue refuses add option $1\" >&2; exit 2 ;;",
  "      *) while [ \"$#\" -gt 0 ]; do printf '%s\\n' \"$1\" >> \"$PUEUE_STATE/add-args.tmp\"; shift; done; break ;;",
  "    esac; done;",
  "    if [ -f \"$PUEUE_STATE/groups.json\" ]; then groups=$(cat \"$PUEUE_STATE/groups.json\");",
  "    else groups='{\"default\":{\"status\":\"Running\",\"parallel_tasks\":1},\"orc\":{\"status\":\"Running\",\"parallel_tasks\":1}}'; fi;",
  "    case \"$groups\" in *\"\\\"$group\\\"\":*) ;; *) echo \"fake pueue has no group $group\" >&2; exit 2 ;; esac;",
  "    while ! mkdir \"$PUEUE_STATE/group-lock\" 2>/dev/null; do sleep 0.05; done;",
  "    if [ -f \"$PUEUE_STATE/added-tasks\" ]; then n=$(wc -l < \"$PUEUE_STATE/added-tasks\"); else n=0; fi;",
  "    id=$((77 + n)); printf '%s %s %s\\n' \"$label\" \"$group\" \"$id\" >> \"$PUEUE_STATE/added-tasks\";",
  "    mv \"$PUEUE_STATE/add-args.tmp\" \"$PUEUE_STATE/add-args\";",
  "    printf '%s' \"$ORC_HOME\" > \"$PUEUE_STATE/add-env.tmp\"; mv \"$PUEUE_STATE/add-env.tmp\" \"$PUEUE_STATE/add-env\";",
  "    rmdir \"$PUEUE_STATE/group-lock\"; echo \"$id\" ;;",
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

const RunnerRun = Schema.Struct({ result: Schema.Struct({ run: Schema.Unknown }) })

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

const queuedEnv = async (fixture: Fixture): Promise<string | null> => {
  const deadline = Date.now() + startWaitMillis
  while (Date.now() < deadline) {
    const text = await readFile(join(fixture.pueue, "add-env"), "utf8").catch(() => null)
    if (text !== null) {
      return text
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
      expect(await queuedEnv(fixture)).toBe(fixture.home)
      expect(await readFile(join(fixture.home, "runner", "task-1.md"), "utf8")).toBe(await readFile(join(fixture.dir, "task.md"), "utf8"))
    })
  }, runnerTimeout)

  test("a start through a command queues on the far side's home, not the dispatcher's", async () => {
    await withFixture(async (fixture) => {
      const far = join(fixture.dir, "far-home")
      const added = await beatStarts(fixture, [process.execPath, binPath, "runner", "start", "--", ...orcThere(far)])
      expect(added).toEqual(pueueAddFor(far, fixture.checkout))
      expect(await queuedEnv(fixture)).toBe(far)
      expect(await readFile(join(far, "runner", "task-1.md"), "utf8")).toBe(await readFile(join(fixture.dir, "task.md"), "utf8"))
    })
  }, runnerTimeout)

  test("a relative ORC_HOME reaches the child resolved instead of relative", async () => {
    await withFixture(async (fixture) => {
      const result = await queueWith(fixture, { task: "task-9", checkout: fixture.checkout, body: "# x\n" }, { ORC_HOME: "rel-home" })
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
      const queued = await queueWith(fixture, { task: "task-9", checkout: sub, body: "# x\n" })
      expect(queued.exitCode).toBe(0)
      const args = (await readFile(join(fixture.pueue, "add-args"), "utf8")).split("\n").slice(0, -1)
      expect(args[args.indexOf("--working-directory") + 1]).toBe(root)
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: { "77": { id: 77, label: "task-9", group: "orc", path: sub, status: { Queued: {} } } }, groups: {} }))
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

  test("a missing orc group is created before queueing instead of refusing the start", async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.pueue, "groups.json"), JSON.stringify({ default: { status: "Running", parallel_tasks: 1 } }))
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
      const result = await queueWith(fixture, { task: "task-9", checkout: fixture.checkout, body: "# x\n" })
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
      const result = await queueWith(fixture, { task: "task-9", checkout: fixture.checkout, body: "# x\n" })
      expect(result.exitCode).toBe(0)
      expect((await readFile(join(fixture.pueue, "group-add-args"), "utf8")).split("\n").slice(0, -1)).toEqual(["group", "add", "orc"])
    })
  }, runnerTimeout)

  test("an existing orc group is left alone instead of added again", async () => {
    await withFixture(async (fixture) => {
      const result = await queueWith(fixture, { task: "task-9", checkout: fixture.checkout, body: "# x\n" })
      expect(result.exitCode).toBe(0)
      expect(await readFile(join(fixture.pueue, "group-add-args"), "utf8").catch(() => null)).toBeNull()
    })
  }, runnerTimeout)

  test("a group added by a rival start is kept instead of failing the queue", async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.pueue, "groups.json"), JSON.stringify({ default: { status: "Running", parallel_tasks: 1 } }))
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
      await writeFile(join(fixture.pueue, "race-add"), "")
      const result = await queueWith(fixture, { task: "task-9", checkout: fixture.checkout, body: "# x\n" })
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
        queueWith(fixture, { task: "task-9", checkout: fixture.checkout, body: "# x\n" }),
        queueWith(fixture, { task: "task-10", checkout: fixture.checkout, body: "# y\n" })
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
      expect(added.some((line) => /^task-9 orc 7[78]$/.test(line))).toBe(true)
      expect(added.some((line) => /^task-10 orc 7[78]$/.test(line))).toBe(true)
    })
  }, runnerTimeout)

  test("a group creation failure without the group still fails the queue", async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.pueue, "groups.json"), JSON.stringify({ default: { status: "Running", parallel_tasks: 1 } }))
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
      await writeFile(join(fixture.pueue, "fail-add"), "")
      const result = await queueWith(fixture, { task: "task-9", checkout: fixture.checkout, body: "# x\n" })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toBe("orc: pueue group exited 1: fake pueue cannot add groups\n")
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
})
