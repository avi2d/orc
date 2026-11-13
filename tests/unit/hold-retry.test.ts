import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Database } from "bun:sqlite"
import { BunServices } from "@effect/platform-bun"
import { DateTime, Duration, Effect, FileSystem, Layer, Redacted } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { fileKeyOf, labelOf } from "../../packages/run/src/entities/backlog/index"
import { insertRun, openDatabase } from "../../packages/run/src/entities/run-history/index"
import { holdToken } from "../../packages/run/src/entities/token/index"
import { holdRun } from "../../packages/run/src/features/queueing-a-task/hold"
import type { Command } from "../../packages/run/src/shared/process/index"

const project = "linux-orc"
const branch = "orc/task"
const priorId = "run-prior"
const ownId = "run-own"

const withHome = async (body: (home: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), "orc-hold-retry-"))
  try {
    await body(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const pinOf = (args: ReadonlyArray<string>): string | null => {
  const found = args.find((entry) => entry.startsWith("ORC_DISPATCH_RESUME_RUN="))
  return found === undefined ? null : found.slice("ORC_DISPATCH_RESUME_RUN=".length)
}

const seed = (db: Database, input: {
  readonly id: string
  readonly taskFile: string
  readonly status: "running" | "succeeded" | "failed" | "stopped"
  readonly started: string
}): void => {
  insertRun(db, { id: input.id, project, branch, taskFile: input.taskFile, status: input.status, started: input.started })
}

const withDb = (home: string, work: (db: Database) => void): Effect.Effect<void, unknown, BunServices.BunServices> =>
  Effect.acquireUseRelease(
    openDatabase(home),
    (db) => Effect.sync(() => work(db)),
    (db) => Effect.sync(() => db.close())
  )

const renew = (home: string, key: string): Effect.Effect<void, unknown, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const now = yield* DateTime.now
    yield* holdToken(home, key, { token: Redacted.make("orc-test-token"), expiresAt: DateTime.addDuration(now, Duration.hours(1)) })
  })

const runHold = (
  home: string,
  command: Command,
  seen: Array<ReadonlyArray<string>>,
  onFirst: () => Effect.Effect<void, never, FileSystem.FileSystem>
): Effect.Effect<string, unknown, BunServices.BunServices> =>
  Effect.gen(function*() {
    const fake = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      return ChildProcessSpawner.make((command) => Effect.gen(function*() {
        seen.push(ChildProcess.isStandardCommand(command) ? [...command.args] : [])
        if (seen.length === 1) {
          yield* TestClock.adjust(Duration.seconds(61))
          yield* onFirst()
          return yield* real.spawn(ChildProcess.make("sh", ["-c", "exit 1"]))
        }
        return yield* real.spawn(ChildProcess.make("sh", ["-c", "exit 0"]))
      }))
    }))
    return yield* Effect.gen(function*() {
      yield* TestClock.setTime(Date.now())
      return yield* holdRun("orc-1", command, home)
    }).pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, TestClock.layer(), fake))
    )
  })

describe("a token-expiry retry of a pinned run", () => {
  test("it resumes the run it just recorded instead of replaying the original pin", async () => {
    await withHome(async (home) => {
      const holderFile = join(home, "runner-task.md")
      const ownFile = join(home, "own-task.md")
      const holderText = "# Do the thing\n"
      await writeFile(holderFile, holderText)
      const key = fileKeyOf(home, "orc-1", labelOf(home, "orc-1", null))
      const command: Command = ["env", "ORC_DISPATCH_RESUME_RUN=" + priorId, "self", "run", holderFile, "--branch", branch]
      const seen: Array<ReadonlyArray<string>> = []
      const result = await Effect.runPromise(Effect.gen(function*() {
        const now = yield* DateTime.now
        yield* withDb(home, (db) => seed(db, { id: priorId, taskFile: holderFile, status: "succeeded", started: "2026-01-01T00:00:00.000Z" }))
        yield* holdToken(home, key, { token: Redacted.make("orc-test-token"), expiresAt: DateTime.addDuration(now, Duration.seconds(330)) })
        const keyFile = key
        return yield* runHold(home, command, seen, () => Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          yield* fs.writeFileString(ownFile, holderText)
          const started = new Date(Date.now() + 1000).toISOString()
          yield* withDb(home, (db) => seed(db, { id: ownId, taskFile: ownFile, status: "failed", started }))
          yield* renew(home, keyFile)
        }))
      }).pipe(Effect.provide(BunServices.layer)))
      expect(result).toBe("the run of orc-1 finished")
      expect(seen).toHaveLength(2)
      expect(pinOf(seen[1] ?? [])).toBe(ownId)
    })
  })

  test("an unrelated latest run never replaces the pinned resume source", async () => {
    await withHome(async (home) => {
      const holderFile = join(home, "runner-task.md")
      const otherFile = join(home, "other-task.md")
      await writeFile(holderFile, "# Do the thing\n")
      await writeFile(otherFile, "# Do another thing\n")
      const key = fileKeyOf(home, "orc-1", labelOf(home, "orc-1", null))
      const command: Command = ["env", "ORC_DISPATCH_RESUME_RUN=" + priorId, "self", "run", holderFile, "--branch", branch]
      const seen: Array<ReadonlyArray<string>> = []
      const result = await Effect.runPromise(Effect.gen(function*() {
        const now = yield* DateTime.now
        const otherStarted = new Date(Date.now() + 1000).toISOString()
        yield* withDb(home, (db) => {
          seed(db, { id: priorId, taskFile: holderFile, status: "succeeded", started: "2026-01-01T00:00:00.000Z" })
          seed(db, { id: "run-other", taskFile: otherFile, status: "failed", started: otherStarted })
        })
        yield* holdToken(home, key, { token: Redacted.make("orc-test-token"), expiresAt: DateTime.addDuration(now, Duration.seconds(330)) })
        const keyFile = key
        return yield* runHold(home, command, seen, () => renew(home, keyFile))
      }).pipe(Effect.provide(BunServices.layer)))
      expect(result).toBe("the run of orc-1 finished")
      expect(seen).toHaveLength(2)
      expect(pinOf(seen[1] ?? [])).toBe(priorId)
    })
  })
})
