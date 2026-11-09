import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import {
  checkHeavy, ensureHeavyWatch, formatCheck, isWholeSuite, lastAlertByMachine, oldRunningTasks,
  splitCommand, staleMachines, watchGroup, watchOnce, watchTtlMinutes
} from "../../../packages/run/src/dispatch/heavy-watch"
import { standinTools } from "../../../packages/run/src/dispatch/heavy-standin"
import { taskLabel } from "../../../packages/run/src/dispatch/pueue-status"

const tools = standinTools([])

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

  test("quoted arguments stay one token", () => {
    expect(splitCommand('taskpolicy -c utility /bin/bun test "my file"')).toEqual(
      ["taskpolicy", "-c", "utility", "/bin/bun", "test", "my file"]
    )
  })

  test("a whole suite run is exempt and a targeted run is not", () => {
    expect(isWholeSuite("bun test", [], tools)).toBe(true)
    expect(isWholeSuite("taskpolicy -c utility /usr/local/bin/bun test", [], tools)).toBe(true)
    expect(isWholeSuite("bun test x", [], tools)).toBe(false)
    expect(isWholeSuite("bun install", [], tools)).toBe(false)
    expect(isWholeSuite("make build", [], tools)).toBe(false)
  })
})

const stateOf = (tasks: Record<string, ReturnType<typeof heavyTask>>, group: string) => ({
  tasks,
  groups: { [group]: { status: "Running", parallel_tasks: 1 } }
})

const taskOf = (id: number, group: string, status: unknown, command: string, created: string) => ({
  id, label: null, command, created_at: created, group, status
})

describe("the stall search", () => {
  test("an old targeted task on a stale machine is reported, whole suites are not", () => {
    const now = Date.parse("2026-01-01T01:00:00Z")
    const minute = 60_000
    const state = stateOf({
      "1": taskOf(1, "heavy", { Running: { start: new Date(now - 20 * minute).toISOString() } }, "bun test x", new Date(now - 20 * minute).toISOString()),
      "2": taskOf(2, "heavy", { Running: { start: new Date(now - 20 * minute).toISOString() } }, "bun test", new Date(now - 20 * minute).toISOString()),
      "3": taskOf(3, "heavy", { Running: { start: new Date(now - 2 * minute).toISOString() } }, "bun test y", new Date(now - 2 * minute).toISOString()),
      "4": taskOf(4, "other", { Running: { start: new Date(now - 20 * minute).toISOString() } }, "bun test z", new Date(now - 20 * minute).toISOString()),
      "5": taskOf(5, "heavy", { Queued: {} }, "bun test w", new Date(now - 20 * minute).toISOString())
    }, "heavy")
    const old = oldRunningTasks(state, "heavy", now, watchTtlMinutes, [], tools)
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
      ]
    }
    expect(formatCheck(check)).toBe(
      "heavy: 1 slot, 0 free, 1 running, 2 queued, oldest queued 4m\n" +
      "  running #1 12m bun test x\n" +
      "  queued #2 4m bun test y\n" +
      "  queued #3 1m bun test"
    )
  })

  test("an empty queue reads quiet", () => {
    expect(formatCheck({ group: "heavy", parallel: 1, running: [], queued: [] })).toBe("heavy: 1 slot, 1 free, 0 running, 0 queued")
  })
})

const quota = { provider: "keyed", command: ["orc-quota"], accounts: [{ name: "main", tokenFile: "/secrets/main-token" }], floorPercent: 15 }

const fakeWatchPueue = `#!/bin/sh
echo "pueue $*" >> "$FAKE_PUEUE_LOG"
case "$1" in
  group) echo '{}';;
  add) echo 9;;
  status) cat "$FAKE_STATE_FILE" || exit 1;;
esac
exit 0
`

const withFakePueue = async <A>(home: string, fn: () => Promise<A>): Promise<A> => {
  const path = process.env.PATH ?? ""
  const savedLog = process.env.FAKE_PUEUE_LOG
  const savedState = process.env.FAKE_STATE_FILE
  process.env.PATH = join(home, "bin") + ":" + path
  process.env.FAKE_PUEUE_LOG = join(home, "pueue.log")
  process.env.FAKE_STATE_FILE = join(home, "state.json")
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
  }
}

const runWatch = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const setupHome = async (machines: ReadonlyArray<string>, alerts: string): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), "orc-heavy-watch-"))
  await mkdir(join(home, "backlog"), { recursive: true })
  await writeFile(
    join(home, "backlog", "dispatch.json"),
    JSON.stringify({ machines: machines.map((name) => ({ name, slots: 1, start: ["true", "runner", "start"] })), quota })
  )
  await writeFile(join(home, "backlog", "alerts.jsonl"), alerts)
  const bin = join(home, "bin")
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, "pueue"), fakeWatchPueue, { mode: 0o755 })
  await writeFile(join(home, "state.json"), JSON.stringify({ tasks: {}, groups: {} }))
  return home
}

const minute = 60_000
const at = (now: number, back: number): string => new Date(now - back * minute).toISOString()

const heavyTask = (id: number, command: string, status: unknown, created: string) => ({
  id, label: null, command, created_at: created, group: "heavy", status
})

const heavyState = (tasks: Record<string, unknown>) => ({
  tasks,
  groups: { heavy: { status: "Running", parallel_tasks: 1 } }
})

describe("the watch loop", () => {
  test("a stale machine with an old targeted task gets a stall alert", async () => {
    const home = await setupHome(["ridge"], "")
    try {
      const now = Date.parse("2026-01-01T01:00:00Z")
      await writeFile(join(home, "state.json"), JSON.stringify(heavyState({
        "1": heavyTask(1, "bun test x", { Running: { start: at(now, 20) } }, at(now, 20))
      })))
      const report = await withFakePueue(home, () => runWatch(watchOnce(home, now)))
      expect(report.stale).toEqual(["ridge"])
      expect(report.old.map((task) => task.id)).toEqual([1])
      expect(report.alerts.length).toBe(1)
      const fired = await readFile(join(home, "backlog", "alerts.jsonl"), "utf8")
      expect(fired).toContain('"rule":"long-task"')
      expect(fired).toContain('"machine":"ridge"')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("a machine that fired recently gets no stall alert", async () => {
    const now = Date.parse("2026-01-01T01:00:00Z")
    const fire = JSON.stringify({ rule: "heavy-load", at: at(now, 1), machine: "ridge", since: at(now, 1), crossed: ["load"] })
    const home = await setupHome(["ridge"], fire + "\n")
    try {
      await writeFile(join(home, "state.json"), JSON.stringify(heavyState({
        "1": heavyTask(1, "bun test x", { Running: { start: at(now, 20) } }, at(now, 20))
      })))
      const report = await withFakePueue(home, () => runWatch(watchOnce(home, now)))
      expect(report.stale).toEqual([])
      expect(report.alerts).toEqual([])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("the check reads running and queued work off the queue", async () => {
    const home = await setupHome(["ridge"], "")
    try {
      const now = Date.parse("2026-01-01T01:00:00Z")
      await writeFile(join(home, "state.json"), JSON.stringify(heavyState({
        "1": heavyTask(1, "bun test x", { Running: { start: at(now, 12) } }, at(now, 12)),
        "2": heavyTask(2, "go test ./...", { Queued: {} }, at(now, 5))
      })))
      const check = await withFakePueue(home, () => runWatch(checkHeavy(home, now)))
      expect(check.group).toBe("heavy")
      expect(check.running.map((task) => task.ageMinutes)).toEqual([12])
      expect(check.queued.map((task) => task.ageMinutes)).toEqual([5])
      expect(formatCheck(check)).toContain("oldest queued 5m")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("the check names pueue when the daemon is unreachable", async () => {
    const home = await setupHome(["ridge"], "")
    try {
      await rm(join(home, "state.json"))
      const failure = await withFakePueue(home, () => runWatch(Effect.flip(checkHeavy(home))))
      expect(failure.detail).toContain("heavy check: pueue is unreachable")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("the check names the group when the queue is missing", async () => {
    const home = await setupHome(["ridge"], "")
    try {
      await writeFile(join(home, "state.json"), JSON.stringify({ tasks: {}, groups: {} }))
      const failure = await withFakePueue(home, () => runWatch(Effect.flip(checkHeavy(home))))
      expect(failure.detail).toContain("heavy check: the heavy group is missing")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("the watch queues once per home and then stands down", async () => {
    const home = await setupHome(["ridge"], "")
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
            group: watchGroup(home), status: { Running: { start: at(Date.now(), 1) } }
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

