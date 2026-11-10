import { describe, expect, test } from "bun:test"
import { skipReason } from "@avi2dg/checks/scripts/test-skips.ts"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Result } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { parseDispatchArgs } from "../../../packages/run/src/dispatch/args"
import { addTask, listTasks } from "../../../packages/run/src/dispatch/backlog"
import { runBeat } from "../../../packages/run/src/dispatch/beat"
import { quietSources } from "../../lib/beat-sources"
import { readDispatchConfig } from "../../../packages/run/src/dispatch/config"
import { deepHeavyQueue, type HeavyReading, type LoadReading, loadText, parseLoad, readMachineLoad } from "../../../packages/run/src/dispatch/load"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const withBacklog = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-load-"))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const quota = { provider: "keyed", command: ["orc-quota"], accounts: [{ name: "main", tokenFile: "/secrets/main-token" }], floorPercent: 15 }

const quotaReply = JSON.stringify({ schema: "orc.quota.v1", accounts: [{ name: "main", remainingPercent: 80 }] })

const quotaStub: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
  const real = yield* ChildProcessSpawner.ChildProcessSpawner
  return ChildProcessSpawner.make((command) =>
    ChildProcess.isStandardCommand(command) && command.command === "orc-quota"
      ? real.spawn(ChildProcess.make("sh", ["-c", "cat <<'J'\n" + quotaReply + "\nJ"]))
      : real.spawn(command)
  )
})).pipe(Layer.provide(BunServices.layer))

const runnerStart = ["true", "runner", "start"] as const

const spec = { title: "Fix the login page", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, dependsOn: [], created: "2026-10-27T10:00:00.000Z", body: "# Fix the login page\n" }

const writeBacklog = async (root: string, machine: Record<string, unknown>): Promise<void> => {
  await writeFile(join(root, "dispatch.json"), JSON.stringify({ machines: [{ name: "ridge", slots: 2, start: runnerStart, ...machine }], quota }))
  await writeFile(join(root, "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { ridge: "/home/a/orc" } }] }))
  await run(addTask(root, spec))
}

const shallow: HeavyReading = { kind: "read", queued: 0, bypassWeek: 0 }

const loadOf = (fiveMinute: number, heavy: HeavyReading = shallow) => (): Effect.Effect<LoadReading> => Effect.succeed({ kind: "read", fiveMinute, heavy })

const beatAt = async (root: string, machine: Record<string, unknown>, readLoad: (machine: { readonly name: string }) => Effect.Effect<LoadReading>) => {
  await writeBacklog(root, machine)
  const report = await Effect.runPromise(runBeat(root, root, quietSources(readLoad)).pipe(Effect.provide(Layer.merge(BunServices.layer, quotaStub))))
  const states = (await run(listTasks(root))).map((task) => task.state.kind)
  return { actions: report.actions.map((action) => action.kind === "waits" ? "waits: " + action.reason : action.kind), states }
}

describe("a machine's five-minute load limit", () => {
  test("a load above the limit leaves the task queued instead of starting it", async () => {
    await withBacklog(async (root) => {
      expect(await beatAt(root, { loadLimit: 16 }, loadOf(16.5))).toEqual({
        actions: ["waits: ridge's five-minute load is 16.5, above its limit of 16"],
        states: ["new"]
      })
    })
  })
  test("a load at the limit starts the task instead of refusing it", async () => {
    await withBacklog(async (root) => {
      expect(await beatAt(root, { loadLimit: 16 }, loadOf(16))).toEqual({ actions: ["started"], states: ["started"] })
    })
  })
  test("a machine with no limit starts the task whatever its load instead of holding it", async () => {
    await withBacklog(async (root) => {
      expect(await beatAt(root, {}, loadOf(99))).toEqual({ actions: ["started"], states: ["started"] })
    })
  })
  test("an unread load on a machine with no limit starts the task instead of holding it", async () => {
    await withBacklog(async (root) => {
      const unread = () => Effect.succeed<LoadReading>({ kind: "unread", reason: "ssh ridge orc runner load exited 255: " })
      expect(await beatAt(root, {}, unread)).toEqual({ actions: ["started"], states: ["started"] })
    })
  })
  test("an unread load leaves the task queued instead of starting blind", async () => {
    await withBacklog(async (root) => {
      const unread = () => Effect.succeed<LoadReading>({ kind: "unread", reason: "ssh ridge orc runner load exited 255: " })
      expect(await beatAt(root, { loadLimit: 16 }, unread)).toEqual({
        actions: ["waits: the load on ridge is unread: ssh ridge orc runner load exited 255: "],
        states: ["new"]
      })
    })
  })
  test("an overloaded machine sends an unpinned task to another with room instead of holding it", async () => {
    await withBacklog(async (root) => {
      await writeFile(join(root, "dispatch.json"), JSON.stringify({
        machines: [{ name: "ridge", slots: 4, start: runnerStart, loadLimit: 16 }, { name: "mac", slots: 1, start: runnerStart }],
        quota
      }))
      await writeFile(join(root, "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { ridge: "/home/a/orc", mac: "/Users/a/orc" } }] }))
      await run(addTask(root, spec))
      const report = await Effect.runPromise(runBeat(root, root, quietSources(loadOf(20))).pipe(Effect.provide(Layer.merge(BunServices.layer, quotaStub))))
      expect(report.actions.map((action) => action.kind === "started" ? action.machine : action.kind)).toEqual(["mac"])
    })
  })
})

describe("a machine's heavy queue depth", () => {
  test("three waiting heavy calls hold the start instead of adding a fourth agent", async () => {
    await withBacklog(async (root) => {
      expect(await beatAt(root, {}, loadOf(1, { kind: "read", queued: 3, bypassWeek: 0 }))).toEqual({
        actions: ["waits: ridge's heavy queue holds 3 waiting calls, at or above its depth limit of 3"],
        states: ["new"]
      })
    })
  })
  test("two waiting heavy calls start the task instead of holding it", async () => {
    await withBacklog(async (root) => {
      expect(await beatAt(root, {}, loadOf(1, { kind: "read", queued: 2, bypassWeek: 9 }))).toEqual({ actions: ["started"], states: ["started"] })
    })
  })
  test("an unread heavy queue starts the task instead of holding the run that makes the queue", async () => {
    await withBacklog(async (root) => {
      const missing: HeavyReading = { kind: "unread", reason: "heavy check: the heavy group is missing, run orc heavy path to create it" }
      expect(await beatAt(root, {}, loadOf(1, missing))).toEqual({ actions: ["started"], states: ["started"] })
    })
  })
  test("a load over its limit names the load instead of the deep queue", async () => {
    await withBacklog(async (root) => {
      expect(await beatAt(root, { loadLimit: 16 }, loadOf(20, { kind: "read", queued: 5, bypassWeek: 0 }))).toEqual({
        actions: ["waits: ridge's five-minute load is 20, above its limit of 16"],
        states: ["new"]
      })
    })
  })
  test("a deep queue on one machine sends an unpinned task to the other instead of holding it", async () => {
    await withBacklog(async (root) => {
      await writeFile(join(root, "dispatch.json"), JSON.stringify({
        machines: [{ name: "ridge", slots: 4, start: runnerStart }, { name: "mac", slots: 1, start: runnerStart }],
        quota
      }))
      await writeFile(join(root, "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { ridge: "/home/a/orc", mac: "/Users/a/orc" } }] }))
      await run(addTask(root, spec))
      const byMachine = (machine: { readonly name: string }) =>
        loadOf(1, { kind: "read", queued: machine.name === "ridge" ? deepHeavyQueue : 0, bypassWeek: 0 })()
      const report = await Effect.runPromise(runBeat(root, root, quietSources(byMachine)).pipe(Effect.provide(Layer.merge(BunServices.layer, quotaStub))))
      expect(report.actions.map((action) => action.kind === "started" ? action.machine : action.kind)).toEqual(["mac"])
    })
  })
  test("a machine whose start is not orc runner start is never read instead of read as this machine", async () => {
    await withBacklog(async (root) => {
      const read: Array<string> = []
      const counted = (machine: { readonly name: string }) => Effect.sync((): LoadReading => {
        read.push(machine.name)
        return { kind: "read", fiveMinute: 1, heavy: { kind: "read", queued: 9, bypassWeek: 0 } }
      })
      expect(await beatAt(root, { start: ["my-start"] }, counted)).toEqual({ actions: ["started"], states: ["started"] })
      expect(read).toEqual([])
    })
  })
})

describe("reading a load limit from dispatch.json", () => {
  const refusal = async (machine: Record<string, unknown>): Promise<string> =>
    withBacklogResult(async (root) => {
      await writeFile(join(root, "dispatch.json"), JSON.stringify({ machines: [{ name: "ridge", slots: 2, start: runnerStart, ...machine }], quota }))
      const result = await run(Effect.result(readDispatchConfig(join(root, "dispatch.json"))))
      return Result.isFailure(result) ? result.failure.detail : "read"
    })
  test("a word, zero or a negative limit is refused naming the machine instead of read", async () => {
    expect(await refusal({ loadLimit: "16" })).toBe("the machine ridge names the load limit \"16\", which is not a number above 0")
    expect(await refusal({ loadLimit: 0 })).toBe("the machine ridge names the load limit 0, which is not a number above 0")
    expect(await refusal({ loadLimit: -2 })).toBe("the machine ridge names the load limit -2, which is not a number above 0")
  })
  test("a limit on a machine whose start is not orc runner start is refused instead of never read", async () => {
    expect(await refusal({ start: ["my-start"], loadLimit: 16 })).toBe(
      "the machine ridge names a load limit, but its start does not run orc runner start, which the beat reads its load through"
    )
  })
  test("a fractional limit is read as given instead of rounded", async () => {
    await withBacklogResult(async (root) => {
      await writeFile(join(root, "dispatch.json"), JSON.stringify({ machines: [{ name: "ridge", slots: 2, start: runnerStart, loadLimit: 7.5 }], quota }))
      expect((await run(readDispatchConfig(join(root, "dispatch.json")))).machines.map((machine) => machine.loadLimit)).toEqual([7.5])
    })
  })
})

const withBacklogResult = async <A>(body: (root: string) => Promise<A>): Promise<A> => {
  const root = await mkdtemp(join(tmpdir(), "orc-load-"))
  try {
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("reading a machine's load", () => {
  test("a machine reached through a command reads the far side's load and heavy queue instead of this one's", async () => {
    const printed = "printf '12.25\\nheavy queue: 4 queued, 1 bypass this week\\n'"
    const machine = { name: "ridge", slots: 2, start: ["true", "runner", "start", "--", "sh", "-c", "[ \"$0 $1\" = 'runner load' ] && " + printed] } as const
    expect(await run(readMachineLoad(machine, "/nowhere"))).toEqual({ kind: "read", fiveMinute: 12.25, heavy: { kind: "read", queued: 4, bypassWeek: 1 } })
  })
  test("a far side that prints no number leaves the load unread instead of reading zero", async () => {
    const machine = { name: "ridge", slots: 2, start: ["true", "runner", "start", "--", "sh", "-c", "echo busy"] } as const
    expect(await run(readMachineLoad(machine, "/nowhere"))).toEqual({ kind: "unread", reason: "sh -c echo busy runner load printed no load: busy" })
  })
  test("a far side that prints a load alone leaves its heavy queue unread instead of reading it empty", async () => {
    const machine = { name: "ridge", slots: 2, start: ["true", "runner", "start", "--", "sh", "-c", "echo 3.5"] } as const
    expect(await run(readMachineLoad(machine, "/nowhere"))).toEqual({
      kind: "read",
      fiveMinute: 3.5,
      heavy: { kind: "unread", reason: "sh -c echo 3.5 runner load printed no heavy queue" }
    })
  })
  test("the printed load reads back as the same reading instead of losing the heavy queue", async () => {
    const readings: ReadonlyArray<HeavyReading> = [
      { kind: "read", queued: 0, bypassWeek: 0 },
      { kind: "read", queued: 1, bypassWeek: 1 },
      { kind: "read", queued: 7, bypassWeek: 12 },
      { kind: "unread", reason: "heavy check: the heavy group is missing, run orc heavy path to create it" }
    ]
    for (const heavy of readings) {
      expect(await run(parseLoad(loadText(0.75, heavy), "orc runner load"))).toEqual({ kind: "read", fiveMinute: 0.75, heavy })
    }
  })
  test("the printed load names the queue and the week's bypasses in words", () => {
    expect(loadText(2, { kind: "read", queued: 1, bypassWeek: 1 })).toBe("2\nheavy queue: 1 queued, 1 bypass this week")
    expect(loadText(2, { kind: "read", queued: 0, bypassWeek: 2 })).toBe("2\nheavy queue: 0 queued, 2 bypasses this week")
  })
  test.skipIf(process.platform !== "linux")(skipReason("needs Linux's /proc/loadavg", "a machine run here reads the five-minute field of /proc/loadavg instead of another", "local"), async () => {
    const reading = await run(readMachineLoad({ name: "here", slots: 1, start: runnerStart }, "/nowhere"))
    const fiveMinute = Number((await readFile("/proc/loadavg", "utf8")).split(" ")[1])
    expect(reading.kind).toBe("read")
    expect(reading.kind === "read" ? Math.abs(reading.fiveMinute - fiveMinute) : Number.NaN).toBeLessThan(0.5)
  })
  test("orc runner load takes no argument instead of ignoring one", () => {
    expect([parseDispatchArgs("runner", ["load"]), parseDispatchArgs("runner", ["load", "now"])]).toEqual([
      { kind: "RunnerLoad" },
      { kind: "UsageError", detail: "unexpected argument: now" }
    ])
  })
})
