import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import {
  checkHeavy, countBypass, ensureHeavyWatch, formatCheck, lastAlertByMachine, lastSlipByCommand, normalizeTaskCommand, oldRunningTasks,
  slipCandidates, slipCovered, slipHeld, staleMachines, stripHeavyWrapper, watchGroup, watchOnce, watchTtlMinutes
} from "../../../packages/run/src/dispatch/heavy-watch"
import { standinScript } from "../../../packages/run/src/dispatch/heavy-standin"
import { heavyBinDir } from "../../../packages/run/src/dispatch/heavy"
import { taskLabel } from "../../../packages/run/src/dispatch/pueue-status"

describe("the heavy watch", () => {
  test("the latest fire per machine decides freshness", () => {
    const text = [
      JSON.stringify({ rule: "heavy-load", at: "2026-01-01T00:10:00Z", machine: "ridge", since: "s", crossed: ["l"] }),
      JSON.stringify({ rule: "heavy-load", at: "2026-01-01T00:05:00Z", machine: "ridge", since: "s", crossed: ["l"] }),
      JSON.stringify({ rule: "heavy-bypass", at: "2026-01-01T00:30:00Z", reason: "x", command: "bun test" }),
      "not json",
      ""
    ].join("\n")
    expect(lastAlertByMachine(text)).toEqual({ ridge: "2026-01-01T00:10:00Z" })
  })

  test("a machine with no fire or an old fire is watched, a fresh one is not", () => {
    const now = Date.parse("2026-01-01T01:00:00Z")
    const fresh = new Date(now - 5 * 60_000).toISOString()
    const old = new Date(now - (watchTtlMinutes + 1) * 60_000).toISOString()
    expect(staleMachines(["a", "b", "c", "d"], { b: fresh, c: old, d: "not-a-date" }, now)).toEqual(["a", "c", "d"])
  })

  test("tool processes become candidates with their script and args", () => {
    const ps = [
      "PID PPID COMMAND",
      "1 0 /sbin/init",
      "100 1 pueued",
      "101 100 bun test queued.test.ts",
      "200 1 bun test rogue.test.ts",
      "201 1 /usr/local/bin/vitest run",
      "202 1 node /usr/local/bin/vitest run",
      "203 1 node server.js",
      "204 1 /tmp/home/heavy/bin/bun test x",
      "205 1 /opt/homebrew/bin/bun /repo/src/bin.ts runner hold x",
      "400 1 ps -eo pid,ppid,command"
    ].join("\n")
    expect(slipCandidates(ps, ["bun", "vitest"], new Set([400]), "/tmp/home/heavy/bin")).toEqual([
      { pid: 101, command: "bun test queued.test.ts", script: "/tmp/home/heavy/bin/bun", args: ["test", "queued.test.ts"] },
      { pid: 200, command: "bun test rogue.test.ts", script: "/tmp/home/heavy/bin/bun", args: ["test", "rogue.test.ts"] },
      { pid: 201, command: "/usr/local/bin/vitest run", script: "/tmp/home/heavy/bin/vitest", args: ["run"] },
      { pid: 202, command: "node /usr/local/bin/vitest run", script: "/tmp/home/heavy/bin/vitest", args: ["run"] },
      { pid: 205, command: "/opt/homebrew/bin/bun /repo/src/bin.ts runner hold x", script: "/tmp/home/heavy/bin/bun", args: ["/repo/src/bin.ts", "runner", "hold", "x"] }
    ])
  })

  test("a running task holds its child behind pueue, a queued task does not", () => {
    const ps = [
      "PID PPID COMMAND",
      "1 0 /sbin/init",
      "100 1 pueued",
      "101 100 /real/bun test queued.test.ts",
      "102 100 /real/bun test other.test.ts",
      "200 1 /real/bun test queued.test.ts"
    ].join("\n")
    const running = new Set([normalizeTaskCommand("taskpolicy -c utility /real/bun test queued.test.ts")])
    expect(slipHeld(ps, 101, running)).toBe(true)
    expect(slipHeld(ps, 102, running)).toBe(false)
    expect(slipHeld(ps, 200, running)).toBe(false)
  })

  test("a waiter-wrapped task holds its child and quotes still match", () => {
    const wrapped = "sh -c 'o=$1; shift' orc-heavy-wait 4242 /real/bun test x"
    const ps = ["PID PPID COMMAND", "1 0 /sbin/init", "100 1 pueued", "101 100 /real/bun test x"].join("\n")
    expect(slipHeld(ps, 101, new Set([normalizeTaskCommand(wrapped)]))).toBe(true)
    const quoted = ["PID PPID COMMAND", "1 0 /sbin/init", "100 1 pueued", "101 100 env -i PATH=/bin bun test x"].join("\n")
    expect(slipHeld(quoted, 101, new Set([normalizeTaskCommand("env -i 'PATH=/bin' bun test x")]))).toBe(true)
  })

  test("a process under nono is covered and a plain one is not", () => {
    const ps = [
      "PID PPID COMMAND",
      "1 0 /sbin/init",
      "50 1 /opt/homebrew/bin/orc run",
      "51 50 /opt/homebrew/bin/nono run --silent",
      "52 51 bun test x",
      "60 1 bun test y"
    ].join("\n")
    expect(slipCovered(ps, 52)).toBe(true)
    expect(slipCovered(ps, 60)).toBe(false)
  })

  test("the wrapper and the priority wrap strip off a task command", () => {
    expect(stripHeavyWrapper("sh -c 'o=$1; shift' orc-heavy-wait 4242 taskpolicy -c utility /real/bun test x")).toBe("/real/bun test x")
    expect(stripHeavyWrapper("taskpolicy -c utility /real/bun test x")).toBe("/real/bun test x")
    expect(stripHeavyWrapper("bun test x")).toBe("bun test x")
  })

  test("the latest slip fire per command decides the reminder", () => {
    const text = [
      JSON.stringify({ rule: "heavy-slip", at: "2026-01-01T00:10:00Z", machine: "ridge", command: "bun test a" }),
      JSON.stringify({ rule: "heavy-slip", at: "2026-01-01T00:05:00Z", machine: "ridge", command: "bun test a" }),
      JSON.stringify({ rule: "heavy-slip", at: "2026-01-01T00:30:00Z", machine: "ridge", command: "bun test b" }),
      "not json",
      ""
    ].join("\n")
    expect(lastSlipByCommand(text)).toEqual({ "bun test a": "2026-01-01T00:10:00Z", "bun test b": "2026-01-01T00:30:00Z" })
  })

  test("bypass lines count and nothing else does", () => {
    const text = [
      JSON.stringify({ rule: "heavy-bypass", at: "2026-01-01T00:10:00Z", reason: "x", command: "bun test" }),
      JSON.stringify({ rule: "heavy-bypass", at: "2026-01-01T00:11:00Z", reason: "y", command: "go test" }),
      JSON.stringify({ rule: "long-task", at: "2026-01-01T00:12:00Z", reason: "total", machine: "m", task: { id: "pueue-1", title: "t" }, quietMinutes: 0, totalMinutes: 20 }),
      "not json",
      ""
    ].join("\n")
    expect(countBypass(text)).toBe(2)
  })
})

const stateOf = (tasks: Record<string, ReturnType<typeof heavyTask>>, group: string) => ({
  tasks,
  groups: { [group]: { status: "Running", parallel_tasks: 1 } }
})

const taskOf = (id: number, group: string, status: unknown, command: string, created: string, priority: number) => ({
  id, label: null, command, created_at: created, group, priority, status
})

describe("the stall search", () => {
  test("an old targeted task on a stale machine is reported, whole suites are not", () => {
    const now = Date.parse("2026-01-01T01:00:00Z")
    const minute = 60_000
    const state = stateOf({
      "1": taskOf(1, "heavy", { Running: { start: new Date(now - 20 * minute).toISOString() } }, "bun test login.test.ts", new Date(now - 20 * minute).toISOString(), 1),
      "2": taskOf(2, "heavy", { Running: { start: new Date(now - 20 * minute).toISOString() } }, "bun test", new Date(now - 20 * minute).toISOString(), 0),
      "3": taskOf(3, "heavy", { Running: { start: new Date(now - 2 * minute).toISOString() } }, "bun test other.test.ts", new Date(now - 2 * minute).toISOString(), 1),
      "4": taskOf(4, "other", { Running: { start: new Date(now - 20 * minute).toISOString() } }, "bun test stray.test.ts", new Date(now - 20 * minute).toISOString(), 1),
      "5": taskOf(5, "heavy", { Queued: {} }, "bun test queued.test.ts", new Date(now - 20 * minute).toISOString(), 1)
    }, "heavy")
    const old = oldRunningTasks(state, "heavy", now, watchTtlMinutes)
    expect(old.map((task) => task.id)).toEqual([1])
    expect(old[0]?.ageMinutes).toBe(20)
  })
})

describe("the check readout", () => {
  test("free slots and queue age read off one line each", () => {
    const check = {
      group: "heavy",
      parallel: 1,
      running: [{ id: 1, command: "bun test x", ageMinutes: 12 }],
      queued: [
        { id: 2, command: "bun test y", ageMinutes: 4 },
        { id: 3, command: "bun test", ageMinutes: 1 }
      ],
      bypass: 2
    }
    expect(formatCheck(check)).toBe(
      "heavy: 1 slot, 0 free, 1 running, 2 queued, oldest queued 4m, 2 bypasses\n" +
      "  running #1 12m bun test x\n" +
      "  queued #2 4m bun test y\n" +
      "  queued #3 1m bun test"
    )
  })

  test("an empty queue reads quiet", () => {
    expect(formatCheck({ group: "heavy", parallel: 1, running: [], queued: [], bypass: 0 })).toBe("heavy: 1 slot, 1 free, 0 running, 0 queued, 0 bypasses")
  })
})

const fakeWatchPueue = `#!/bin/sh
echo "pueue $*" >> "$FAKE_PUEUE_LOG"
case "$1" in
  group) echo '{}';;
  add) echo 9;;
  status) cat "$FAKE_STATE_FILE" || exit 1;;
esac
exit 0
`

const fakeWatchPs = `#!/bin/sh
cat "$FAKE_PS_FILE"
`

const emptyPs = "PID PPID COMMAND\n1 0 /sbin/init\n"

const withFakePueue = async <A>(home: string, fn: () => Promise<A>): Promise<A> => {
  const path = process.env.PATH ?? ""
  const savedLog = process.env.FAKE_PUEUE_LOG
  const savedState = process.env.FAKE_STATE_FILE
  const savedPs = process.env.FAKE_PS_FILE
  process.env.PATH = join(home, "bin") + ":" + path
  process.env.FAKE_PUEUE_LOG = join(home, "pueue.log")
  process.env.FAKE_STATE_FILE = join(home, "state.json")
  process.env.FAKE_PS_FILE = join(home, "ps.txt")
  try {
    return await fn()
  } finally {
    process.env.PATH = path
    if (savedLog === undefined) {
      delete process.env.FAKE_PUEUE_LOG
    } else {
      process.env.FAKE_PUEUE_LOG = savedLog
    }
    if (savedState === undefined) {
      delete process.env.FAKE_STATE_FILE
    } else {
      process.env.FAKE_STATE_FILE = savedState
    }
    if (savedPs === undefined) {
      delete process.env.FAKE_PS_FILE
    } else {
      process.env.FAKE_PS_FILE = savedPs
    }
  }
}

const runWatch = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const setupHome = async (alerts: string): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), "orc-heavy-watch-"))
  await mkdir(join(home, "backlog"), { recursive: true })
  await writeFile(join(home, "backlog", "alerts.jsonl"), alerts)
  const bin = join(home, "bin")
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, "pueue"), fakeWatchPueue, { mode: 0o755 })
  await writeFile(join(bin, "ps"), fakeWatchPs, { mode: 0o755 })
  await writeFile(join(home, "ps.txt"), emptyPs)
  await writeFile(join(home, "state.json"), JSON.stringify({ tasks: {}, groups: {} }))
  const heavyBin = heavyBinDir(home)
  await mkdir(heavyBin, { recursive: true })
  const settings = { home, group: "heavy", wrap: "" }
  await writeFile(join(heavyBin, "bun"), standinScript("bun", settings, []), { mode: 0o755 })
  await writeFile(join(heavyBin, "vitest"), standinScript("vitest", settings, []), { mode: 0o755 })
  return home
}

const minute = 60_000
const at = (now: number, back: number): string => new Date(now - back * minute).toISOString()

const heavyTask = (id: number, command: string, status: unknown, created: string, priority: number) => ({
  id, label: null, command, created_at: created, group: "heavy", priority, status
})

const heavyState = (tasks: Record<string, unknown>) => ({
  tasks,
  groups: { heavy: { status: "Running", parallel_tasks: 1 } }
})

describe("the watch loop", () => {
  test("an old targeted task gets a stall alert", async () => {
    const home = await setupHome("")
    try {
      const now = Date.parse("2026-01-01T01:00:00Z")
      await writeFile(join(home, "state.json"), JSON.stringify(heavyState({
        "1": heavyTask(1, "bun test login.test.ts", { Running: { start: at(now, 20) } }, at(now, 20), 1)
      })))
      const report = await withFakePueue(home, () => runWatch(watchOnce(home, now)))
      expect(report.old.map((task) => task.id)).toEqual([1])
      expect(report.alerts.length).toBe(1)
      expect(report.slips).toEqual([])
      const fired = await readFile(join(home, "backlog", "alerts.jsonl"), "utf8")
      expect(fired).toContain('"rule":"long-task"')
      expect(fired).toContain('"machine":"' + hostname() + '"')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("a machine that fired recently gets no stall alert", async () => {
    const now = Date.parse("2026-01-01T01:00:00Z")
    const fire = JSON.stringify({ rule: "heavy-load", at: at(now, 1), machine: hostname(), since: at(now, 1), crossed: ["load"] })
    const home = await setupHome(fire + "\n")
    try {
      await writeFile(join(home, "state.json"), JSON.stringify(heavyState({
        "1": heavyTask(1, "bun test login.test.ts", { Running: { start: at(now, 20) } }, at(now, 20), 1)
      })))
      const report = await withFakePueue(home, () => runWatch(watchOnce(home, now)))
      expect(report.alerts).toEqual([])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("a heavy tool process with no running task gets one slip alert", async () => {
    const home = await setupHome("")
    try {
      const now = Date.parse("2026-01-01T01:00:00Z")
      await writeFile(join(home, "state.json"), JSON.stringify(heavyState({
        "1": heavyTask(1, "bun test queued.test.ts", { Running: { start: at(now, 1) } }, at(now, 1), 0)
      })))
      await writeFile(
        join(home, "ps.txt"),
        ["PID PPID COMMAND", "1 0 /sbin/init", "100 1 pueued", "101 100 bun test queued.test.ts", "200 1 bun test rogue.test.ts"].join("\n") + "\n"
      )
      const first = await withFakePueue(home, () => runWatch(watchOnce(home, now)))
      expect(first.slips).toEqual(["bun test rogue.test.ts"])
      expect(first.alerts.length).toBe(1)
      const fired = await readFile(join(home, "backlog", "alerts.jsonl"), "utf8")
      expect(fired).toContain('"rule":"heavy-slip"')
      expect(fired).toContain('"machine":"' + hostname() + '"')
      expect(fired).toContain('"command":"bun test rogue.test.ts"')
      const second = await withFakePueue(home, () => runWatch(watchOnce(home, now)))
      expect(second.slips).toEqual([])
      expect(second.alerts).toEqual([])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("the check reads running and queued work off the queue", async () => {
    const home = await setupHome("")
    try {
      const now = Date.parse("2026-01-01T01:00:00Z")
      await writeFile(join(home, "state.json"), JSON.stringify(heavyState({
        "1": heavyTask(1, "bun test x", { Running: { start: at(now, 12) } }, at(now, 12), 1),
        "2": heavyTask(2, "go test ./...", { Queued: {} }, at(now, 5), 0)
      })))
      const check = await withFakePueue(home, () => runWatch(checkHeavy(home, now)))
      expect(check.group).toBe("heavy")
      expect(check.running.map((task) => task.ageMinutes)).toEqual([12])
      expect(check.queued.map((task) => task.ageMinutes)).toEqual([5])
      expect(check.bypass).toBe(0)
      expect(formatCheck(check)).toContain("oldest queued 5m")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("the check counts bypasses off the alerts log", async () => {
    const bypass = JSON.stringify({ rule: "heavy-bypass", at: at(Date.now(), 1), reason: "hotfix", command: "bun test" })
    const home = await setupHome(bypass + "\n" + bypass + "\n")
    try {
      await writeFile(join(home, "state.json"), JSON.stringify(heavyState({})))
      const check = await withFakePueue(home, () => runWatch(checkHeavy(home)))
      expect(check.bypass).toBe(2)
      expect(formatCheck(check)).toContain(", 2 bypasses")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("the check names pueue when the daemon is unreachable", async () => {
    const home = await setupHome("")
    try {
      await rm(join(home, "state.json"))
      const failure = await withFakePueue(home, () => runWatch(Effect.flip(checkHeavy(home))))
      expect(failure.detail).toContain("heavy check: pueue is unreachable")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("the check names the group when the queue is missing", async () => {
    const home = await setupHome("")
    try {
      await writeFile(join(home, "state.json"), JSON.stringify({ tasks: {}, groups: {} }))
      const failure = await withFakePueue(home, () => runWatch(Effect.flip(checkHeavy(home))))
      expect(failure.detail).toContain("heavy check: the heavy group is missing")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("the watch queues once per home and then stands down", async () => {
    const home = await setupHome("")
    try {
      const line = await withFakePueue(home, () => runWatch(ensureHeavyWatch(home, ["orc"])))
      expect(line).toContain("queued the heavy watch as pueue task 9")
      const log = await readFile(join(home, "pueue.log"), "utf8")
      expect(log).toContain("add --group " + watchGroup(home))
      expect(log).toContain("--label " + taskLabel(home, "heavy-watch"))
      expect(log).toContain("heavy watch-once")
      await writeFile(join(home, "state.json"), JSON.stringify({
        tasks: {
          "9": {
            id: 9, label: taskLabel(home, "heavy-watch"), command: "sh", created_at: at(Date.now(), 1),
            group: watchGroup(home), priority: 0, status: { Running: { start: at(Date.now(), 1) } }
          }
        },
        groups: {}
      }))
      const again = await withFakePueue(home, () => runWatch(ensureHeavyWatch(home, ["orc"])))
      expect(again).toBe(null)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

