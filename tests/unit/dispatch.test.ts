import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Result } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { parseDispatchArgs } from "../../packages/run/src/dispatch/args"
import { addTask, claimTask, closeStartedTask, listTasks, releaseTask, writeTaken } from "../../packages/run/src/dispatch/backlog"
import { placeTask, runBeat } from "../../packages/run/src/dispatch/beat"
import { quietSources } from "../lib/beat-sources"
import { formatBeat } from "../../packages/run/src/dispatch/board"
import { insertRun, openDatabase } from "../../packages/run/src/run-history"
import { type DispatchConfig, type Project, readDispatchConfig } from "../../packages/run/src/dispatch/config"
import { assessQuota } from "../../packages/run/src/dispatch/quota"
import { taskLabel } from "../../packages/run/src/dispatch/pueue-status"
import type { TaskRecord } from "../../packages/run/src/dispatch/task-record"
import { renderTaskFile } from "../../packages/run/src/dispatch/task-record-render"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const withBacklog = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-dispatch-"))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const spec = { title: "Fix the thing", project: "orc", kind: "ship" as const, internal: false, machine: null, dependsOn: [], created: "2026-10-27T10:00:00.000Z", body: "# Fix the thing\n" }

const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-10-27T10:01:00.000Z" }

const config: DispatchConfig = {
  machines: [{ name: "mac", slots: 1, start: ["true"] }, { name: "linux", slots: 4, start: ["true"] }],
  quota: { provider: "keyed", command: ["orc-quota"], accounts: [{ name: "main", kind: "token-file", tokenFile: "/secrets/main-token" }], floorPercent: 15 }
}

const projects: ReadonlyArray<Project> = [{ name: "orc", checkouts: { mac: "/Users/a/orc", linux: "/home/a/orc" } }]

const newTask = (machine: string | null): TaskRecord => ({ spec: { ...spec, id: "task-1", machine }, hold: null, parked: null, state: { kind: "new" } })

const quotaReply = JSON.stringify({ schema: "orc.quota.v1", accounts: [{ name: "main", remainingPercent: 80 }] })

// Answers pueue status and the quota command itself, and runs every other command for real.
const pueueStub = (statusJson: string): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner
    return ChildProcessSpawner.make((command) =>
      ChildProcess.isStandardCommand(command) && command.command === "pueue"
        ? real.spawn(ChildProcess.make("sh", ["-c", "cat <<'J'\n" + statusJson + "\nJ"]))
        : ChildProcess.isStandardCommand(command) && command.command === "orc-quota"
          ? real.spawn(ChildProcess.make("sh", ["-c", "cat <<'J'\n" + quotaReply + "\nJ"]))
          : real.spawn(command)
    )
  }))

// Answers the quota command itself and reads the task file at the moment the beat asks for the start command, before any process runs.
const recordingSpawner = (taskFile: string, seen: Array<string>): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner, never, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem> =>
  Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner
    const fs = yield* FileSystem.FileSystem
    return ChildProcessSpawner.make((command) =>
      ChildProcess.isStandardCommand(command) && command.command === "orc-quota"
        ? real.spawn(ChildProcess.make("sh", ["-c", "cat <<'J'\n" + quotaReply + "\nJ"]))
        : fs.readFileString(taskFile).pipe(
          Effect.tap((text) => Effect.sync(() => seen.push(text))),
          Effect.flatMap(() => real.spawn(command))
        )
    )
  }))

describe("parseDispatchArgs", () => {
  test("backlog with no argument shows the board, not JSON", () => {
    expect(parseDispatchArgs("backlog", [])).toEqual({ kind: "ShowBacklog", json: false })
  })
  test("backlog --json shows JSON", () => {
    expect(parseDispatchArgs("backlog", ["--json"])).toEqual({ kind: "ShowBacklog", json: true })
  })
  test("add keeps a repeated --depends-on instead of the last one only", () => {
    expect(parseDispatchArgs("backlog", ["add", "orc", "t.md", "--depends-on", "task-1", "--machine", "mac", "--depends-on", "task-2"])).toEqual({
      kind: "AddTask",
      project: "orc",
      task: { kind: "file", path: "t.md" },
      taskKind: "ship",
      internal: false,
      machine: "mac",
      dependsOn: ["task-1", "task-2"]
    })
  })
  test("add reads the task from stdin on - instead of from a file named -", () => {
    expect(parseDispatchArgs("backlog", ["add", "orc", "-", "--machine", "mac"])).toEqual({
      kind: "AddTask",
      project: "orc",
      task: { kind: "stdin" },
      taskKind: "ship",
      internal: false,
      machine: "mac",
      dependsOn: []
    })
  })
  test("add records --internal on a ship task instead of dropping it", () => {
    expect(parseDispatchArgs("backlog", ["add", "orc", "t.md", "--internal"])).toMatchObject({ kind: "AddTask", taskKind: "ship", internal: true })
  })
  test("add refuses --internal on a scout instead of marking a task with no PR", () => {
    expect(parseDispatchArgs("backlog", ["add", "orc", "t.md", "--kind", "scout", "--internal"]).kind).toBe("UsageError")
  })
  test("add refuses a second --machine instead of keeping either", () => {
    expect(parseDispatchArgs("backlog", ["add", "orc", "t.md", "--machine", "mac", "--machine", "linux"]).kind).toBe("UsageError")
  })
  test("add refuses a flag with no value instead of taking the next flag as it", () => {
    expect(parseDispatchArgs("backlog", ["add", "orc", "t.md", "--machine", "--depends-on", "task-1"]).kind).toBe("UsageError")
  })
  test("close refuses an outcome other than done or failed", () => {
    expect(parseDispatchArgs("backlog", ["close", "task-1", "merged"]).kind).toBe("UsageError")
  })
  test("posted takes one task id and refuses a second instead of marking only the first", () => {
    expect(parseDispatchArgs("backlog", ["posted", "task-1"])).toEqual({ kind: "MarkPosted", id: "task-1" })
    expect(parseDispatchArgs("backlog", ["posted", "task-1", "task-2"])).toEqual({ kind: "UsageError", detail: "unexpected argument: task-2" })
    expect(parseDispatchArgs("backlog", ["posted", "../task-1"]).kind).toBe("UsageError")
  })
  test("beat refuses an unknown argument instead of ignoring it", () => {
    expect(parseDispatchArgs("beat", ["--dry-run"])).toEqual({ kind: "UsageError", detail: "unexpected argument: --dry-run" })
  })
  test("runner start with no -- queues here", () => {
    expect(parseDispatchArgs("runner", ["start"])).toEqual({ kind: "RunnerStart", reach: { kind: "here" } })
  })
  test("runner result hands every word after -- to the command instead of reading --json as its own", () => {
    expect(parseDispatchArgs("runner", ["result", "task-1", "--", "ssh", "linux", "orc", "--json"])).toEqual({
      kind: "RunnerResult",
      task: "task-1",
      json: false,
      reach: { kind: "through", command: ["ssh", "linux", "orc", "--json"] },
      stdinLabel: false
    })
  })
  test("runner result reads --json before -- as its own", () => {
    expect(parseDispatchArgs("runner", ["result", "task-1", "--json", "--", "ssh", "linux", "orc"])).toEqual({
      kind: "RunnerResult",
      task: "task-1",
      json: true,
      reach: { kind: "through", command: ["ssh", "linux", "orc"] },
      stdinLabel: false
    })
  })
  test("a label-less result reads no stdin marker instead of waiting on a pipe", () => {
    expect(parseDispatchArgs("runner", ["result", "task-1"])).toEqual({
      kind: "RunnerResult",
      task: "task-1",
      json: false,
      reach: { kind: "here" },
      stdinLabel: false
    })
  })
  test("a forwarded result marks its stdin label instead of leaving the far side to guess", () => {
    expect(parseDispatchArgs("runner", ["result", "task-1", "--json", "--stdin-label"])).toEqual({
      kind: "RunnerResult",
      task: "task-1",
      json: true,
      reach: { kind: "here" },
      stdinLabel: true
    })
  })
  test("a result with a repeated stdin marker is refused instead of read twice", () => {
    expect(parseDispatchArgs("runner", ["result", "task-1", "--stdin-label", "--stdin-label"]).kind).toBe("UsageError")
  })
  test("runner answer refuses a reach instead of forwarding the answers", () => {
    expect(parseDispatchArgs("runner", ["answer", "task-1", "--", "ssh", "linux", "orc"]).kind).toBe("UsageError")
    expect(parseDispatchArgs("runner", ["answer", "task-1"])).toEqual({ kind: "RunnerAnswer", task: "task-1" })
  })
  test("runner answer refuses an answer on argv instead of letting a remote shell split it", () => {
    expect(parseDispatchArgs("runner", ["answer", "task-1", "r2=Keep it"])).toEqual({ kind: "UsageError", detail: "unexpected argument: r2=Keep it" })
    expect(parseDispatchArgs("runner", ["answer", "../task-1"]).kind).toBe("UsageError")
  })
  test("runner -- with no command is refused instead of reading here", () => {
    expect(parseDispatchArgs("runner", ["start", "--"]).kind).toBe("UsageError")
    expect(parseDispatchArgs("runner", ["result", "task-1", "--"]).kind).toBe("UsageError")
  })
  test("runner result refuses a word that is no task id instead of looking it up", () => {
    expect(parseDispatchArgs("runner", ["result", "../task-1"]).kind).toBe("UsageError")
  })
  test("runner refuses stray words and verbs instead of ignoring them", () => {
    expect(parseDispatchArgs("runner", ["start", "now"]).kind).toBe("UsageError")
    expect(parseDispatchArgs("runner", ["queue", "task-1"]).kind).toBe("UsageError")
    expect(parseDispatchArgs("runner", ["stop", "task-1"]).kind).toBe("UsageError")
    expect(parseDispatchArgs("runner", []).kind).toBe("UsageError")
  })
  test("runner renew reaches through the command after -- instead of renewing here", () => {
    expect(parseDispatchArgs("runner", ["renew", "--", "ssh", "linux", "orc"])).toEqual({
      kind: "RunnerRenew",
      reach: { kind: "through", command: ["ssh", "linux", "orc"] }
    })
  })
  test("runner hold hands every word after -- to the run instead of reading them as its own", () => {
    expect(parseDispatchArgs("runner", ["hold", "task-1", "--", "orc", "run", "--json"])).toEqual({
      kind: "RunnerHold",
      task: "task-1",
      run: ["orc", "run", "--json"]
    })
  })
  test("runner hold with no run command is refused instead of holding a token for nothing", () => {
    expect(parseDispatchArgs("runner", ["hold", "task-1"]).kind).toBe("UsageError")
    expect(parseDispatchArgs("runner", ["hold", "../task-1", "--", "orc"]).kind).toBe("UsageError")
  })
})

const configProblem = async (root: string, quota: object): Promise<string | null> => {
  const file = join(root, "dispatch.json")
  await writeFile(file, JSON.stringify({ machines: config.machines, quota: { ...config.quota, ...quota } }))
  return run(readDispatchConfig(file).pipe(
    Effect.map(() => null),
    Effect.catchTag("ConfigError", (error) => Effect.succeed(error.detail))
  ))
}

describe("readDispatchConfig", () => {
  test("keeps the provider, the quota command and each account's token file path", async () => {
    await withBacklog(async (root) => {
      const file = join(root, "dispatch.json")
      await writeFile(file, JSON.stringify(config))
      expect((await run(readDispatchConfig(file))).quota).toEqual(config.quota)
    })
  })
  test("refuses an account with no token file instead of starting its runs on none", async () => {
    await withBacklog(async (root) => {
      expect(await configProblem(root, { accounts: [{ name: "main" }] })).not.toBeNull()
    })
  })
  test("refuses a relative token file path instead of resolving it against the run's folder", async () => {
    await withBacklog(async (root) => {
      const problem = await configProblem(root, { accounts: [{ name: "main", tokenFile: "secrets/main-token" }] })
      expect(problem).toContain("the account main")
      expect(problem).toContain("tokenFile")
    })
  })
  test("refuses an account named twice instead of keeping either token file", async () => {
    await withBacklog(async (root) => {
      expect(await configProblem(root, { accounts: [{ name: "main", tokenFile: "/a" }, { name: "main", tokenFile: "/b" }] })).toBe("the account main is named twice")
    })
  })
  test("refuses an account with both a token file and a token command instead of picking one", async () => {
    await withBacklog(async (root) => {
      expect(await configProblem(root, { accounts: [{ name: "main", tokenFile: "/a", tokenCommand: ["my-token-command", "main"] }] })).not.toBeNull()
    })
  })
  test("refuses a token command account while a machine has no renew command instead of letting its runs lapse", async () => {
    await withBacklog(async (root) => {
      expect(await configProblem(root, { accounts: [{ name: "main", tokenCommand: ["my-token-command", "main"] }] })).toBe(
        "the machine mac has no renew command, which the account main needs to carry its token past its expiry"
      )
    })
  })
  test("keeps a token command account once every machine has a renew command", async () => {
    await withBacklog(async (root) => {
      const file = join(root, "dispatch.json")
      const machines = config.machines.map((machine) => ({ ...machine, renew: ["true"] }))
      const accounts = [{ name: "main", tokenCommand: ["my-token-command", "main"] }] as const
      await writeFile(file, JSON.stringify({ machines, quota: { ...config.quota, accounts } }))
      expect((await run(readDispatchConfig(file))).quota.accounts).toEqual([{ name: "main", kind: "token-command", tokenCommand: ["my-token-command", "main"] }])
    })
  })
  test("refuses a quota with no command instead of reading a built-in tool", async () => {
    await withBacklog(async (root) => {
      expect(await configProblem(root, { command: [] })).not.toBeNull()
    })
  })
  test("refuses a quota with no provider instead of handing the accounts to any provider", async () => {
    await withBacklog(async (root) => {
      const file = join(root, "dispatch.json")
      await writeFile(file, JSON.stringify({ machines: config.machines, quota: { command: config.quota.command, accounts: config.quota.accounts, floorPercent: 15 } }))
      const read = await run(readDispatchConfig(file).pipe(Effect.as("read"), Effect.catchTag("ConfigError", () => Effect.succeed("refused"))))
      expect(read).toBe("refused")
    })
  })
})

describe("assessQuota", () => {
  const settings = (...names: ReadonlyArray<string>) => ({ command: ["orc-quota"] as const, accounts: names.map((name) => ({ name })), floorPercent: 15 })
  const document = (accounts: ReadonlyArray<object>) => ({ schema: "orc.quota.v1", accounts })
  test("runs use the account with most room, not the first listed", () => {
    const reading = assessQuota(document([{ name: "main", remainingPercent: 40 }, { name: "second", remainingPercent: 80 }]), settings("main", "second"))
    expect(reading).toEqual({
      kind: "read",
      floorPercent: 15,
      accounts: [{ account: "main", kind: "usable", remainingPercent: 40 }, { account: "second", kind: "usable", remainingPercent: 80 }],
      pick: "second"
    })
  })
  test("an account below the floor is not picked", () => {
    const reading = assessQuota(document([{ name: "main", remainingPercent: 10 }]), settings("main"))
    expect(reading.kind === "read" ? reading.pick : "unread").toBeNull()
  })
  test("an account the command calls unusable keeps the command's reason instead of being picked", () => {
    const reading = assessQuota(document([{ name: "main", unusable: "the login expired" }]), settings("main"))
    expect(reading).toEqual({ kind: "read", floorPercent: 15, accounts: [{ account: "main", kind: "unusable", reason: "the login expired" }], pick: null })
  })
  test("an account the command does not name is unusable instead of assumed full", () => {
    const reading = assessQuota(document([{ name: "other", remainingPercent: 90 }]), settings("main"))
    expect(reading.kind === "read" ? reading.accounts : []).toEqual([{ account: "main", kind: "unusable", reason: "the quota command names no account main" }])
  })
  test("an entry naming both room and a reason is refused instead of read as usable", () => {
    expect(assessQuota(document([{ name: "main", remainingPercent: 90, unusable: "spent" }]), settings("main")).kind).toBe("unread")
  })
  test("room above 100 percent is refused instead of read as room", () => {
    expect(assessQuota(document([{ name: "main", remainingPercent: 140 }]), settings("main")).kind).toBe("unread")
  })
  test("a document without the orc.quota.v1 schema is refused with the missing key instead of a bare refusal", () => {
    expect(assessQuota({ accounts: [{ name: "main", remainingPercent: 90 }] }, settings("main"))).toEqual({ kind: "unread", reason: "the quota command printed no orc.quota.v1 document: Missing key\n  at [\"schema\"]" })
  })
  test("room above 100 percent names the out of range percent instead of a bare refusal", () => {
    const reading = assessQuota(document([{ name: "main", remainingPercent: 120 }]), settings("main"))
    expect(reading.kind === "unread" ? reading.reason : "read").toContain("Expected a value between 0 and 100\n  at [\"accounts\"][0][\"remainingPercent\"]")
  })
  test("a misspelled remainingPercent names the missing key instead of a bare refusal", () => {
    const reading = assessQuota(document([{ name: "main", remaining: 90 }]), settings("main"))
    expect(reading.kind === "unread" ? reading.reason : "read").toContain("Missing key\n  at [\"accounts\"][0][\"remainingPercent\"]")
  })
  test("a wrong schema name names the expected literal instead of a bare refusal", () => {
    const reading = assessQuota({ schema: "orc.quota.v2", accounts: [{ name: "main", remainingPercent: 90 }] }, settings("main"))
    expect(reading).toEqual({ kind: "unread", reason: "the quota command printed no orc.quota.v1 document: Expected \"orc.quota.v1\"\n  at [\"schema\"]" })
  })
  test("an account named twice is refused instead of taking either reading", () => {
    const reading = assessQuota(document([{ name: "main", remainingPercent: 10 }, { name: "main", remainingPercent: 90 }]), settings("main"))
    expect(reading).toEqual({ kind: "unread", reason: "the quota command names the account main twice" })
  })
})

describe("placeTask", () => {
  const room = [{ machine: "mac", slots: 1, busy: 1 }, { machine: "linux", slots: 4, busy: 0 }]
  test("a task marked for a full machine waits instead of going to a machine with room", () => {
    expect(placeTask(newTask("mac"), config, projects, room)).toEqual({ kind: "waits", reason: "mac has no room" })
  })
  test("a task marked for a machine goes there even when another has more room", () => {
    const placement = placeTask(newTask("mac"), config, projects, [{ machine: "mac", slots: 1, busy: 0 }, { machine: "linux", slots: 4, busy: 0 }])
    expect(placement.kind === "place" ? placement.machine.name : placement.reason).toBe("mac")
  })
  test("an unmarked task goes to the machine with room instead of the first listed", () => {
    const placement = placeTask(newTask(null), config, projects, room)
    expect(placement.kind === "place" ? [placement.machine.name, placement.checkout] : placement.reason).toEqual(["linux", "/home/a/orc"])
  })
  test("a task marked for a machine with no checkout of its project waits", () => {
    const onlyMac: ReadonlyArray<Project> = [{ name: "orc", checkouts: { mac: "/Users/a/orc" } }]
    expect(placeTask(newTask("linux"), config, onlyMac, room).kind).toBe("waits")
  })
})

describe("the backlog folders", () => {
  test("of ten claims racing for one task exactly one wins instead of several", async () => {
    await withBacklog(async (root) => {
      const record = await run(addTask(root, spec))
      const wins = await run(Effect.all(Array.from({ length: 10 }, () => claimTask(root, record.spec.id)), { concurrency: "unbounded" }))
      expect(wins.filter(Boolean)).toHaveLength(1)
      expect(await readdir(join(root, "taken"))).toEqual(["orc-1.md"])
      expect(await readdir(join(root, "new"))).toEqual([])
    })
  })
  test("tasks added at once take distinct ids instead of one id twice", async () => {
    await withBacklog(async (root) => {
      const records = await run(Effect.all(Array.from({ length: 8 }, () => addTask(root, spec)), { concurrency: "unbounded" }))
      expect(new Set(records.map((record) => record.spec.id)).size).toBe(8)
      expect((await run(listTasks(root))).map((record) => record.spec.id)).toEqual(Array.from({ length: 8 }, (_, index) => "orc-" + (index + 1)))
    })
  })
  test("a taken task given back is new again instead of lost", async () => {
    await withBacklog(async (root) => {
      const record = await run(addTask(root, spec))
      await run(claimTask(root, record.spec.id))
      const taken: TaskRecord = { spec: record.spec, hold: null, parked: null, state: { kind: "taken", claim } }
      await run(writeTaken(root, taken))
      await run(releaseTask(root, taken))
      expect((await run(listTasks(root))).map((task) => task.state)).toEqual([{ kind: "new" }])
    })
  })
  test("a taken task that never started is refused a close instead of closed", async () => {
    await withBacklog(async (root) => {
      const record = await run(addTask(root, spec))
      await run(claimTask(root, record.spec.id))
      const result = await run(Effect.result(closeStartedTask(root, record.spec.id, "done", "", { pr: null, report: null }, "2026-10-27T11:00:00.000Z")))
      expect(Result.isFailure(result)).toBe(true)
    })
  })
  test("a closed task leaves taken instead of being listed twice", async () => {
    await withBacklog(async (root) => {
      const record = await run(addTask(root, spec))
      await run(claimTask(root, record.spec.id))
      await run(writeTaken(root, { spec: record.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-10-27T10:02:00.000Z", log: root + "/logs/orc-1.log" } } }))
      await run(closeStartedTask(root, record.spec.id, "done", "merged", { pr: null, report: null }, "2026-10-27T11:00:00.000Z"))
      const tasks = await run(listTasks(root))
      expect(tasks.map((task) => task.state.kind)).toEqual(["closed"])
      expect(await readdir(join(root, "taken"))).toEqual([])
    })
  })
})

describe("the beat", () => {
  test("the task file says started before the start command is spawned instead of after", async () => {
    await withBacklog(async (root) => {
      await writeFile(join(root, "dispatch.json"), JSON.stringify({ ...config, machines: [{ name: "mac", slots: 1, start: ["true"] }, { name: "linux", slots: 0, start: ["true"] }] }))
      await writeFile(join(root, "projects.json"), JSON.stringify({ projects }))
      await run(addTask(root, spec))
      const seen: Array<string> = []
      const spawner = recordingSpawner(join(root, "taken", "orc-1.md"), seen).pipe(Layer.provide(BunServices.layer))
      const report = await Effect.runPromise(runBeat(root, root, quietSources()).pipe(Effect.provide(Layer.merge(BunServices.layer, spawner))))
      expect(report.actions.map((action) => action.kind)).toEqual(["started"])
      expect(seen).toHaveLength(1)
      expect(seen[0]).toContain("started_at: ")
    })
  })
})

const macProjects = [{ name: "orc", checkouts: { mac: "/checkout" } }]

const orcStart = ["orc", "runner", "start"]

type BeatSpawner = Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>

const startTaskOne = async (root: string, start: ReadonlyArray<string>, next: { readonly dependsOn: ReadonlyArray<string> } | null): Promise<void> => {
  await writeFile(join(root, "dispatch.json"), JSON.stringify({ ...config, machines: [{ name: "mac", slots: 1, start }] }))
  await writeFile(join(root, "projects.json"), JSON.stringify({ projects: macProjects }))
  await run(addTask(root, spec))
  if (next !== null) {
    await run(addTask(root, { ...spec, title: "Fix the other thing", dependsOn: next.dependsOn }))
  }
  await run(claimTask(root, "orc-1"))
  const first = (await run(listTasks(root))).find((task) => task.spec.id === "orc-1")
  if (first === undefined) {
    throw new Error("the backlog holds no orc-1")
  }
  await run(writeTaken(root, { spec: first.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-10-27T10:02:00.000Z", log: root + "/logs/orc-1.log" } } }))
}

const pueueAnswering = (root: string, status: unknown): BeatSpawner =>
  pueueStub(JSON.stringify({ tasks: { "11": { id: 11, label: taskLabel(root, "orc-1"), group: "orc", path: "/checkout", status } } })).pipe(Layer.provide(BunServices.layer))

const pueueDone = (root: string, result: unknown): BeatSpawner =>
  pueueAnswering(root, { Done: { start: "2026-10-27T10:02:00.000Z", end: "2026-10-27T10:05:00.000Z", result } })

const pueueInstead = (onPueue: ReturnType<typeof ChildProcessSpawner.ChildProcessSpawner.of>["spawn"]): BeatSpawner =>
  Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner
    return ChildProcessSpawner.make((command) =>
      ChildProcess.isStandardCommand(command) && command.command === "pueue"
        ? onPueue(command)
        : ChildProcess.isStandardCommand(command) && command.command === "orc-quota"
          ? real.spawn(ChildProcess.make("sh", ["-c", "cat <<'J'\n" + quotaReply + "\nJ"]))
          : real.spawn(command)
    )
  })).pipe(Layer.provide(BunServices.layer))

const beatWith = (root: string, spawner: BeatSpawner) =>
  Effect.runPromise(runBeat(root, root, quietSources()).pipe(Effect.provide(Layer.merge(BunServices.layer, spawner))))

const backlogStates = async (root: string): Promise<ReadonlyArray<string>> =>
  (await run(listTasks(root))).map((task) => task.spec.id + ":" + task.state.kind)

interface BeatAfterRun {
  readonly states: ReadonlyArray<string>
  readonly actions: ReadonlyArray<string>
  readonly reasons: ReadonlyArray<string>
  readonly prs: ReadonlyArray<string | null>
  readonly lines: ReadonlyArray<string>
}

const recordRun = (home: string, prLink: string): Promise<void> =>
  run(Effect.acquireUseRelease(
    openDatabase(home),
    (db) => Effect.sync(() => insertRun(db, { id: "run-1", project: "/checkout", branch: "orc/orc-1", taskFile: "orc-1.md", status: "succeeded", started: "2026-10-27T10:02:00.000Z", prLink })),
    (db) => Effect.sync(() => db.close())
  ))

const beatAfterRun = async (root: string, result: unknown): Promise<BeatAfterRun> => {
  await startTaskOne(root, orcStart, { dependsOn: [] })
  const report = await beatWith(root, pueueDone(root, result))
  const tasks = await run(listTasks(root))
  return {
    states: tasks.map((task) => task.spec.id + ":" + task.state.kind),
    actions: report.actions.map((action) => action.kind + ":" + ("task" in action ? action.task : "")),
    reasons: tasks.flatMap((task) => task.state.kind === "closed" ? [task.state.closing.outcome + ":" + task.state.closing.reason] : []),
    prs: tasks.flatMap((task) => task.state.kind === "closed" && task.state.closing.outcome !== "start-failed" ? [task.state.closing.pr] : []),
    lines: formatBeat(report).split("\n").filter((line) => line.startsWith("closed "))
  }
}

describe("the beat's closing sweep", () => {
  test("a started task whose pueue run succeeded is closed done and its slot starts the next task instead of staying started", async () => {
    await withBacklog(async (root) => {
      const beat = await beatAfterRun(root, "Success")
      expect(beat.states).toEqual(["orc-1:closed", "orc-2:started"])
      expect(beat.reasons).toEqual(["done:pueue task 11 succeeded"])
      expect(beat.actions).toEqual(["closed:orc-1", "started:orc-2"])
    })
  })
  test("a closed task keeps the PR its run opened instead of only the pueue reason", async () => {
    await withBacklog(async (root) => {
      await recordRun(root, "https://github.com/example/orc/pull/7")
      const beat = await beatAfterRun(root, "Success")
      expect(beat.prs).toEqual(["https://github.com/example/orc/pull/7"])
      expect(beat.lines).toEqual(["closed orc-1 done on mac: pueue task 11 succeeded, PR https://github.com/example/orc/pull/7"])
      const closed = (await run(listTasks(root))).find((task) => task.spec.id === "orc-1")
      expect(closed === undefined ? "" : renderTaskFile(closed)).toContain('pr: "https://github.com/example/orc/pull/7"')
    })
  })
  test("a failed run with no PR closes with none instead of an empty link", async () => {
    await withBacklog(async (root) => {
      const beat = await beatAfterRun(root, { Failed: 3 })
      expect(beat.prs).toEqual([null])
      expect(beat.lines).toEqual(["closed orc-1 failed on mac: orc exited 3"])
    })
  })
  test("a started task whose pueue run still runs stays started and keeps its slot instead of closing early", async () => {
    await withBacklog(async (root) => {
      await startTaskOne(root, orcStart, { dependsOn: [] })
      const report = await beatWith(root, pueueAnswering(root, { Running: { start: "2026-10-27T10:02:00.000Z" } }))
      expect(await backlogStates(root)).toEqual(["orc-1:started", "orc-2:new"])
      expect(report.actions.map((action) => action.kind + ":" + ("task" in action ? action.task : ""))).toEqual(["stalled:orc-1", "waits:orc-2"])
    })
  })
  test("a started task whose pueue run failed is closed failed with the run's reason instead of staying started", async () => {
    await withBacklog(async (root) => {
      const beat = await beatAfterRun(root, { Failed: 3 })
      expect(beat.states).toEqual(["orc-1:closed", "orc-2:started"])
      expect(beat.reasons).toEqual(["failed:orc exited 3"])
      expect(beat.actions).toEqual(["closed:orc-1", "started:orc-2"])
    })
  })
  test("a task waiting on a just-finished task starts in the same beat instead of waiting one more beat", async () => {
    await withBacklog(async (root) => {
      await startTaskOne(root, orcStart, { dependsOn: ["orc-1"] })
      const report = await beatWith(root, pueueDone(root, "Success"))
      expect(await backlogStates(root)).toEqual(["orc-1:closed", "orc-2:started"])
      expect(report.actions.map((action) => action.kind + ":" + ("task" in action ? action.task : ""))).toEqual(["closed:orc-1", "started:orc-2"])
    })
  })
  test("a started task on a machine with a custom start is left alone instead of read and reported", async () => {
    await withBacklog(async (root) => {
      await startTaskOne(root, ["true"], null)
      await mkdir(join(root, "logs"), { recursive: true })
      await writeFile(join(root, "logs", "orc-1.log"), "run output\n")
      const report = await beatWith(root, pueueInstead(() => Effect.die("the sweep read pueue on a custom-start machine")))
      expect(await backlogStates(root)).toEqual(["orc-1:started"])
      expect(report.actions).toEqual([])
    })
  })
  test("a close read that never answers reports close-failed after 30 seconds and closes only once unread past the grace instead of closing on the first timeout", async () => {
    await withBacklog(async (root) => {
      await startTaskOne(root, orcStart, null)
      const first = await beatWith(root, pueueInstead(() => Effect.never))
      expect(await backlogStates(root)).toEqual(["orc-1:started"])
      expect(first.actions.flatMap((action) => action.kind === "close-failed" ? [action.task + ":" + action.reason] : []))
        .toEqual(["orc-1:the close read timed out after 30 seconds"])
      await writeFile(join(root, "logs", "orc-1.unread"), "2026-10-27T10:02:00.000Z")
      const report = await beatWith(root, pueueInstead(() => Effect.never))
      expect(await backlogStates(root)).toEqual(["orc-1:closed"])
      expect(report.actions.flatMap((action) => action.kind === "closed" ? [action.task + ":" + action.reason] : []))
        .toEqual(["orc-1:the close read timed out after 30 seconds"])
    })
  }, 180_000)
})


