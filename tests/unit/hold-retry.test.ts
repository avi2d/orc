import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Database } from "bun:sqlite"
import { BunServices } from "@effect/platform-bun"
import { Cause, DateTime, Duration, Effect, FileSystem, Layer, Redacted, type PlatformError } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { fileKeyOf, labelOf } from "../../packages/run/src/entities/backlog/index"
import { insertRun, openDatabase, runById } from "../../packages/run/src/entities/run-history/index"
import { holdToken } from "../../packages/run/src/entities/token/index"
import { holdRun } from "../../packages/run/src/features/queueing-a-task/hold"
import type { Command, RunnerError } from "../../packages/run/src/shared/process/index"

const project = "linux-orc"
const branch = "orc/task"
const priorId = "run-prior"
const operatorId = "run-operator"

const resumePrefix = "ORC_DISPATCH_RESUME_RUN="
const attemptPrefix = "ORC_DISPATCH_RUN_ID="

const withHome = async (body: (home: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), "orc-hold-retry-"))
  try {
    await body(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const valueOf = (args: ReadonlyArray<string>, prefix: string): string | null => {
  const found = args.find((entry) => entry.startsWith(prefix))
  return found === undefined ? null : found.slice(prefix.length)
}

const seed = (db: Database, input: {
  readonly id: string
  readonly taskFile: string
  readonly status: "running" | "succeeded" | "failed" | "stopped"
  readonly started: string
}): void => {
  insertRun(db, { id: input.id, project, branch, taskFile: input.taskFile, status: input.status, started: input.started })
}

const withDb = (home: string, body: (db: Database) => Promise<void>): Promise<void> =>
  Effect.runPromise(Effect.gen(function*() {
    const db = yield* openDatabase(home)
    try {
      yield* Effect.promise(() => body(db))
    } finally {
      db.close()
    }
  }).pipe(Effect.provide(BunServices.layer)))

const renew = (home: string, key: string): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const now = yield* DateTime.now
    yield* holdToken(home, key, { token: Redacted.make("orc-test-token"), expiresAt: DateTime.addDuration(now, Duration.hours(1)) })
  })

const runHold = (
  home: string,
  command: Command,
  seen: Array<ReadonlyArray<string>>,
  first: (attempt: string | null) => Effect.Effect<void, PlatformError.PlatformError | Cause.UnknownError, FileSystem.FileSystem>
): Effect.Effect<string, RunnerError | PlatformError.PlatformError | Cause.UnknownError, BunServices.BunServices> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const fake = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      return ChildProcessSpawner.make((spawned) =>
        Effect.gen(function*() {
          seen.push(ChildProcess.isStandardCommand(spawned) ? [...spawned.args] : [])
          if (seen.length === 1) {
            yield* TestClock.adjust(Duration.seconds(61))
            yield* first(valueOf(seen[0] ?? [], attemptPrefix)).pipe(Effect.orDie)
            return yield* real.spawn(ChildProcess.make("sh", ["-c", "exit 1"]))
          }
          return yield* real.spawn(ChildProcess.make("sh", ["-c", "exit 0"]))
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs)
        ))
    }))
    const live = fake.pipe(Layer.provideMerge(Layer.mergeAll(BunServices.layer, TestClock.layer())))
    return yield* Effect.gen(function*() {
      yield* TestClock.setTime(Date.now())
      return yield* holdRun("orc-1", command, home)
    }).pipe(Effect.provide(live))
  })

const holdCommand = (pin: string, holderFile: string): Command =>
  ["env", resumePrefix + pin, "self", "run", holderFile, "--branch", branch]

describe("a token-expiry retry of a pinned run", () => {
  test("it resumes the exact attempt its child recorded instead of the original pin", async () => {
    await withHome(async (home) => {
      const holderFile = join(home, "runner-task.md")
      await writeFile(holderFile, "# Do the thing\n")
      const key = fileKeyOf(home, "orc-1", labelOf(home, "orc-1", null))
      const seen: Array<ReadonlyArray<string>> = []
      const result = await Effect.runPromise(Effect.gen(function*() {
        const now = yield* DateTime.now
        yield* Effect.promise(() => withDb(home, async (db) => {
          seed(db, { id: priorId, taskFile: holderFile, status: "succeeded", started: "2026-01-01T00:00:00.000Z" })
        }))
        yield* holdToken(home, key, { token: Redacted.make("orc-test-token"), expiresAt: DateTime.addDuration(now, Duration.seconds(330)) })
        const keyFile = key
        const holder = holderFile
        return yield* runHold(home, holdCommand(priorId, holderFile), seen, (attempt) =>
          Effect.gen(function*() {
            if (attempt === null || attempt === "") {
              return yield* Effect.die(new Error("the holder sent no attempt id"))
            }
            const started = new Date().toISOString()
            yield* Effect.promise(() => withDb(home, async (db) => {
              seed(db, { id: attempt, taskFile: holder, status: "failed", started })
            }))
            yield* renew(home, keyFile)
          }))
      }).pipe(Effect.provide(BunServices.layer)))
      expect(result).toBe("the run of orc-1 finished")
      expect(seen).toHaveLength(2)
      const attempt = valueOf(seen[0] ?? [], attemptPrefix)
      expect(attempt).not.toBeNull()
      expect(valueOf(seen[1] ?? [], resumePrefix)).toBe(attempt)
      let recorded: string | null = null
      await withDb(home, async (db) => {
        const found = await Effect.runPromise(Effect.orElseSucceed(runById(db, attempt ?? ""), () => null))
        recorded = found === null ? null : found.id
      })
      expect<string | null>(recorded).toBe(attempt)
    })
  })

  test("a separate invocation with identical task bytes never replaces the pinned resume source", async () => {
    await withHome(async (home) => {
      const holderFile = join(home, "runner-task.md")
      await writeFile(holderFile, "# Do the thing\n")
      const key = fileKeyOf(home, "orc-1", labelOf(home, "orc-1", null))
      const seen: Array<ReadonlyArray<string>> = []
      const result = await Effect.runPromise(Effect.gen(function*() {
        const now = yield* DateTime.now
        const operatorStarted = new Date(Date.now() + 120000).toISOString()
        yield* Effect.promise(() => withDb(home, async (db) => {
          seed(db, { id: priorId, taskFile: holderFile, status: "succeeded", started: "2026-01-01T00:00:00.000Z" })
          seed(db, { id: operatorId, taskFile: holderFile, status: "failed", started: operatorStarted })
        }))
        yield* holdToken(home, key, { token: Redacted.make("orc-test-token"), expiresAt: DateTime.addDuration(now, Duration.seconds(330)) })
        const keyFile = key
        const holder = holderFile
        return yield* runHold(home, holdCommand(priorId, holderFile), seen, (attempt) =>
          Effect.gen(function*() {
            if (attempt === null || attempt === "") {
              return yield* Effect.die(new Error("the holder sent no attempt id"))
            }
            const started = new Date().toISOString()
            yield* Effect.promise(() => withDb(home, async (db) => {
              seed(db, { id: attempt, taskFile: holder, status: "failed", started })
            }))
            yield* renew(home, keyFile)
          }))
      }).pipe(Effect.provide(BunServices.layer)))
      expect(result).toBe("the run of orc-1 finished")
      expect(seen).toHaveLength(2)
      const attempt = valueOf(seen[0] ?? [], attemptPrefix)
      expect(attempt).not.toBeNull()
      expect(attempt).not.toBe(operatorId)
      expect(valueOf(seen[1] ?? [], resumePrefix)).toBe(attempt)
    })
  })

  test("an unrecorded attempt keeps the original pin", async () => {
    await withHome(async (home) => {
      const holderFile = join(home, "runner-task.md")
      await writeFile(holderFile, "# Do the thing\n")
      const key = fileKeyOf(home, "orc-1", labelOf(home, "orc-1", null))
      const seen: Array<ReadonlyArray<string>> = []
      const result = await Effect.runPromise(Effect.gen(function*() {
        const now = yield* DateTime.now
        yield* Effect.promise(() => withDb(home, async (db) => {
          seed(db, { id: priorId, taskFile: holderFile, status: "succeeded", started: "2026-01-01T00:00:00.000Z" })
        }))
        yield* holdToken(home, key, { token: Redacted.make("orc-test-token"), expiresAt: DateTime.addDuration(now, Duration.seconds(330)) })
        const keyFile = key
        return yield* runHold(home, holdCommand(priorId, holderFile), seen, () => renew(home, keyFile))
      }).pipe(Effect.provide(BunServices.layer)))
      expect(result).toBe("the run of orc-1 finished")
      expect(seen).toHaveLength(2)
      expect(valueOf(seen[1] ?? [], resumePrefix)).toBe(priorId)
    })
  })

  test("an unrelated latest run never replaces the pinned resume source", async () => {
    await withHome(async (home) => {
      const holderFile = join(home, "runner-task.md")
      const otherFile = join(home, "other-task.md")
      await writeFile(holderFile, "# Do the thing\n")
      await writeFile(otherFile, "# Do another thing\n")
      const key = fileKeyOf(home, "orc-1", labelOf(home, "orc-1", null))
      const seen: Array<ReadonlyArray<string>> = []
      const result = await Effect.runPromise(Effect.gen(function*() {
        const now = yield* DateTime.now
        const otherStarted = new Date(Date.now() + 1000).toISOString()
        yield* Effect.promise(() => withDb(home, async (db) => {
          seed(db, { id: priorId, taskFile: holderFile, status: "succeeded", started: "2026-01-01T00:00:00.000Z" })
          seed(db, { id: operatorId, taskFile: otherFile, status: "failed", started: otherStarted })
        }))
        yield* holdToken(home, key, { token: Redacted.make("orc-test-token"), expiresAt: DateTime.addDuration(now, Duration.seconds(330)) })
        const keyFile = key
        return yield* runHold(home, holdCommand(priorId, holderFile), seen, () => renew(home, keyFile))
      }).pipe(Effect.provide(BunServices.layer)))
      expect(result).toBe("the run of orc-1 finished")
      expect(seen).toHaveLength(2)
      expect(valueOf(seen[1] ?? [], resumePrefix)).toBe(priorId)
    })
  })
})
