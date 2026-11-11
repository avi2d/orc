import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Option } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { addTask, claimTask, listTasks, writeTaken } from "../../../packages/run/src/dispatch/backlog"
import { flagStall } from "../../../packages/run/src/dispatch/stall"
import { markEventPosted, unpostedEvents } from "../../../packages/run/src/dispatch/events"
import { openDatabase, recordRun } from "../../../packages/run/src/run-history"
import { runBeat } from "../../../packages/run/src/dispatch/beat"
import { quietSources } from "../../lib/beat-sources"
import { formatBeat } from "../../../packages/run/src/dispatch/board"
import type { LoadReading } from "../../../packages/run/src/dispatch/load"
import { taskLabel } from "../../../packages/run/src/dispatch/pueue-status"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const withBacklog = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-stall-"))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const spec = { title: "Fix the login page", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], created: "2026-10-27T10:00:00.000Z", body: "# Fix the login page\n" }

const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-10-27T10:01:00.000Z" }

const quota = { provider: "keyed", command: ["orc-quota"], accounts: [{ name: "main", tokenFile: "/secrets/main-token" }], floorPercent: 15 }

const quotaReply = JSON.stringify({ schema: "orc.quota.v1", accounts: [{ name: "main", remainingPercent: 80 }] })

const writtenAt = Date.parse("2026-10-27T11:00:00.000Z")

const minutesAfterWrite = (minutes: number): number => writtenAt + minutes * 60 * 1000

type PueueState = { readonly Running: { readonly start: string } } | { readonly Done: { readonly start: string; readonly end: string; readonly result: "Success" } }

const running: PueueState = { Running: { start: "2026-10-27T10:02:00.000Z" } }

const pueueWith = (root: string, state: PueueState): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> => {
  const status = JSON.stringify({ tasks: { "11": { id: 11, label: taskLabel(root, "task-1"), group: "orc", path: "/checkout", status: state } } })
  return Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner
    const reply = (text: string) => real.spawn(ChildProcess.make("sh", ["-c", "cat <<'J'\n" + text + "\nJ"]))
    return ChildProcessSpawner.make((command) =>
      ChildProcess.isStandardCommand(command) && command.command === "pueue"
        ? reply(status)
        : ChildProcess.isStandardCommand(command) && command.command === "orc-quota" ? reply(quotaReply) : real.spawn(command)
    )
  })).pipe(Layer.provide(BunServices.layer))
}

const unreadLoad = (): Effect.Effect<LoadReading> => Effect.succeed({ kind: "unread", reason: "no load read in a stall test" })

const startTask = async (root: string, start: ReadonlyArray<string>, log: string): Promise<void> => {
  await writeFile(join(root, "dispatch.json"), JSON.stringify({ machines: [{ name: "mac", slots: 1, start }], quota }))
  await writeFile(join(root, "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { mac: "/checkout" } }] }))
  await run(addTask(root, spec))
  await run(claimTask(root, "task-1"))
  await run(writeTaken(root, { spec: { ...spec, id: "task-1" }, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-10-27T10:02:00.000Z", log } } }))
}

const touch = async (file: string, at: number): Promise<void> => {
  await writeFile(file, "output\n")
  await utimes(file, at / 1000, at / 1000)
}

const seedRun = async (root: string): Promise<void> => {
  const db = await Effect.runPromise(openDatabase(root).pipe(Effect.provide(BunServices.layer)))
  try {
    Effect.runSync(recordRun(db, { id: "run-1", project: "/checkout", branch: "orc/task-1", taskFile: "task.md", status: "running", started: "2026-10-27T10:02:00.000Z" }))
  } finally {
    db.close()
  }
  await mkdir(join(root, "runs", "run-1"), { recursive: true })
}

const beatAt = async (root: string, now: number, state: PueueState = running): Promise<ReadonlyArray<string>> => {
  const beat = Effect.gen(function*() {
    yield* TestClock.setTime(now)
    return yield* runBeat(root, root, quietSources(unreadLoad))
  })
  const report = await Effect.runPromise(beat.pipe(Effect.provide(Layer.mergeAll(BunServices.layer, pueueWith(root, state), TestClock.layer()))))
  return formatBeat(report).split("\n").filter((line) => line.startsWith("stalled ") || line.startsWith("closed "))
}

const stalledLine = "stalled task-1 on mac: no output since 2026-10-27T11:00:00.000Z"

describe("a pueue run's stall", () => {
  test("output 30 minutes old flags the run instead of waiting longer", async () => {
    await withBacklog(async (root) => {
      await startTask(root, ["orc", "runner", "start"], join(root, "logs", "task-1.log"))
      await seedRun(root)
      await touch(join(root, "runs", "run-1", "agent.log"), writtenAt)
      expect(await beatAt(root, minutesAfterWrite(30))).toEqual([stalledLine])
    })
  })
  test("output 29 minutes old is not flagged instead of flagging early", async () => {
    await withBacklog(async (root) => {
      await startTask(root, ["orc", "runner", "start"], join(root, "logs", "task-1.log"))
      await seedRun(root)
      await touch(join(root, "runs", "run-1", "agent.log"), writtenAt)
      expect(await beatAt(root, minutesAfterWrite(29))).toEqual([])
    })
  })
  test("one stall is flagged once instead of on every beat", async () => {
    await withBacklog(async (root) => {
      await startTask(root, ["orc", "runner", "start"], join(root, "logs", "task-1.log"))
      await seedRun(root)
      await touch(join(root, "runs", "run-1", "agent.log"), writtenAt)
      expect(await beatAt(root, minutesAfterWrite(30))).toEqual([stalledLine])
      expect(await beatAt(root, minutesAfterWrite(40))).toEqual([])
    })
  })
  test("new output clears the flag and a second stall flags again instead of staying silent", async () => {
    await withBacklog(async (root) => {
      await startTask(root, ["orc", "runner", "start"], join(root, "logs", "task-1.log"))
      await seedRun(root)
      await touch(join(root, "runs", "run-1", "agent.log"), writtenAt)
      expect(await beatAt(root, minutesAfterWrite(30))).toEqual([stalledLine])
      await touch(join(root, "runs", "run-1", "agent.log"), minutesAfterWrite(35))
      expect(await beatAt(root, minutesAfterWrite(50))).toEqual([])
      expect(await beatAt(root, minutesAfterWrite(65))).toEqual(["stalled task-1 on mac: no output since 2026-10-27T11:35:00.000Z"])
    })
  })
  test("a fresh agent log stays silent instead of flagging a healthy run", async () => {
    await withBacklog(async (root) => {
      await startTask(root, ["orc", "runner", "start"], join(root, "logs", "task-1.log"))
      await seedRun(root)
      await touch(join(root, "runs", "run-1", "agent.log"), minutesAfterWrite(29))
      expect(await beatAt(root, minutesAfterWrite(30))).toEqual([])
    })
  })
  test("a run with no run-folder log falls back to its start instead of staying silent", async () => {
    await withBacklog(async (root) => {
      await startTask(root, ["orc", "runner", "start"], join(root, "logs", "task-1.log"))
      await seedRun(root)
      expect(await beatAt(root, minutesAfterWrite(30))).toEqual(["stalled task-1 on mac: no output since 2026-10-27T10:02:00.000Z"])
    })
  })
  test("a fresh gate log stays silent instead of flagging a run in review", async () => {
    await withBacklog(async (root) => {
      await startTask(root, ["orc", "runner", "start"], join(root, "logs", "task-1.log"))
      await seedRun(root)
      await touch(join(root, "runs", "run-1", "gate.log"), minutesAfterWrite(29))
      expect(await beatAt(root, minutesAfterWrite(30))).toEqual([])
    })
  })
  test("a fresh checks file stays silent instead of flagging a run in checks", async () => {
    await withBacklog(async (root) => {
      await startTask(root, ["orc", "runner", "start"], join(root, "logs", "task-1.log"))
      await seedRun(root)
      await touch(join(root, "runs", "run-1", "checks-1.txt"), minutesAfterWrite(29))
      expect(await beatAt(root, minutesAfterWrite(30))).toEqual([])
    })
  })
  test("a finished run is closed instead of flagged however old its output", async () => {
    await withBacklog(async (root) => {
      await startTask(root, ["orc", "runner", "start"], join(root, "logs", "task-1.log"))
      const done: PueueState = { Done: { start: "2026-10-27T10:02:00.000Z", end: "2026-10-27T11:00:00.000Z", result: "Success" } }
      const lines = await beatAt(root, minutesAfterWrite(90), done)
      expect(lines.filter((line) => line.startsWith("stalled "))).toEqual([])
      expect(lines.filter((line) => line.startsWith("closed "))).toHaveLength(1)
    })
  })
})

const chatPosts = async (root: string): Promise<ReadonlyArray<string>> => {
  const events = await run(unpostedEvents(root))
  for (const event of events) {
    await run(markEventPosted(root, event.key))
  }
  return events.map((event) => event.text)
}

describe("a stall in the chat", () => {
  test("one stall posts once instead of on every beat", async () => {
    await withBacklog(async (root) => {
      await startTask(root, ["orc", "runner", "start"], join(root, "logs", "task-1.log"))
      await seedRun(root)
      await touch(join(root, "runs", "run-1", "agent.log"), writtenAt)
      await beatAt(root, minutesAfterWrite(30))
      expect(await chatPosts(root)).toEqual(["task-1 Fix the login page stalled on mac: no output since 2026-10-27T11:00:00.000Z"])
      await beatAt(root, minutesAfterWrite(40))
      expect(await chatPosts(root)).toEqual([])
    })
  })
  test("a second stall posts again instead of reading as the posted first", async () => {
    await withBacklog(async (root) => {
      await startTask(root, ["orc", "runner", "start"], join(root, "logs", "task-1.log"))
      await seedRun(root)
      await touch(join(root, "runs", "run-1", "agent.log"), writtenAt)
      await beatAt(root, minutesAfterWrite(30))
      expect(await chatPosts(root)).toHaveLength(1)
      await touch(join(root, "runs", "run-1", "agent.log"), minutesAfterWrite(35))
      await beatAt(root, minutesAfterWrite(50))
      expect(await chatPosts(root)).toEqual([])
      await beatAt(root, minutesAfterWrite(65))
      expect(await chatPosts(root)).toEqual(["task-1 Fix the login page stalled on mac: no output since 2026-10-27T11:35:00.000Z"])
    })
  })
})

describe("a custom start's stall", () => {
  test("a backlog log 30 minutes old flags the run instead of waiting longer", async () => {
    await withBacklog(async (root) => {
      const log = join(root, "logs", "task-1.log")
      await startTask(root, ["true"], log)
      await touch(log, writtenAt)
      expect(await beatAt(root, minutesAfterWrite(30))).toEqual([stalledLine])
    })
  })
  test("a backlog log 29 minutes old is not flagged instead of flagging early", async () => {
    await withBacklog(async (root) => {
      const log = join(root, "logs", "task-1.log")
      await startTask(root, ["true"], log)
      await touch(log, writtenAt)
      expect(await beatAt(root, minutesAfterWrite(29))).toEqual([])
    })
  })
})

describe("a failed close read", () => {
  test("keeps the stall flag instead of flagging the same stall again", async () => {
    await withBacklog(async (root) => {
      await startTask(root, ["orc", "runner", "start"], join(root, "logs", "task-1.log"))
      const task = (await run(listTasks(root))).find((entry) => entry.spec.id === "task-1") ?? null
      expect(task?.state.kind).toBe("started")
      if (task === null || task.state.kind !== "started") {
        throw new Error("task-1 is not started")
      }
      const active = { kind: "running", outputAt: "2026-10-27T11:00:00.000Z", action: null } as const
      const failed = { kind: "ended", action: { kind: "close-failed", task: "task-1", machine: "mac", reason: "the close read timed out" } } as const
      const flagAt = (progress: typeof active | typeof failed, now: number) =>
        Effect.runPromise(Effect.gen(function*() {
          yield* TestClock.setTime(now)
          return yield* flagStall(root, task, progress)
        }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, TestClock.layer()))))
      expect(Option.isSome(await flagAt(active, minutesAfterWrite(30)))).toBe(true)
      expect(Option.isNone(await flagAt(failed, minutesAfterWrite(31)))).toBe(true)
      expect(Option.isNone(await flagAt(active, minutesAfterWrite(32)))).toBe(true)
    })
  })
})

describe("a task that has not started", () => {
  test("is never flagged instead of being read as a silent run", async () => {
    await withBacklog(async (root) => {
      await writeFile(join(root, "dispatch.json"), JSON.stringify({ machines: [{ name: "mac", slots: 0, start: ["true"] }], quota }))
      await writeFile(join(root, "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { mac: "/checkout" } }] }))
      await run(addTask(root, spec))
      expect(await beatAt(root, minutesAfterWrite(600))).toEqual([])
    })
  })
})
