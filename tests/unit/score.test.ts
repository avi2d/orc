import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Database } from "bun:sqlite"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { openDatabase, recordRun, recordStep } from "../../packages/run/src/entities/run-history/index"
import { readShow, recordStepScore, UnknownStep } from "../../packages/run/src/features/seeing-runs/index"

const withHome = async (use: (home: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), "orc-score-"))
  try {
    await use(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const openDb = (home: string): Promise<Database> =>
  Effect.runPromise(openDatabase(home).pipe(Effect.provide(BunServices.layer)))

describe("orc score step selection", () => {
  test("plain fix scores the latest fix in execution order after resume publish order", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        await Effect.runPromise(recordRun(db, {
          id: "resume-score-1",
          project: "orc",
          branch: "orc/demo",
          taskFile: "/tmp/show-home/runs/resume-score-1/task.md",
          status: "running",
          started: "2026-10-18T10:00:00.000Z"
        }))
        await Effect.runPromise(recordStep(db, {
          runId: "resume-score-1",
          name: "fix",
          attempt: 2,
          status: "running",
          started: "2026-10-18T10:06:00.000Z"
        }))
        await Effect.runPromise(recordStep(db, {
          runId: "resume-score-1",
          name: "fix",
          attempt: 1,
          status: "passed",
          started: "2026-10-18T10:03:10.000Z",
          ended: "2026-10-18T10:03:50.000Z"
        }))
        await Effect.runPromise(recordStepScore(db, {
          runId: "resume-score-1",
          step: "fix",
          score: 5,
          note: "latest",
          scoredAt: "2026-10-18T12:00:00.000Z"
        }))
        const document = await Effect.runPromise(readShow(db, "resume-score-1"))
        expect(document?.steps.map((step) => step.attempt)).toEqual([1, 2])
        expect(document?.steps[0]?.score).toBeNull()
        expect(document?.steps[1]?.score).toEqual({ score: 5, note: "latest", scoredAt: "2026-10-18T12:00:00.000Z" })
      } finally {
        db.close()
      }
    })
  })

  test("fix with an attempt scores that attempt and leaves the other attempt alone", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        await Effect.runPromise(recordRun(db, {
          id: "attempt-score-1",
          project: "orc",
          branch: "orc/demo",
          taskFile: "/tmp/show-home/runs/attempt-score-1/task.md",
          status: "running",
          started: "2026-10-18T10:00:00.000Z"
        }))
        await Effect.runPromise(recordStep(db, {
          runId: "attempt-score-1",
          name: "fix",
          attempt: 1,
          status: "passed",
          started: "2026-10-18T10:03:10.000Z",
          ended: "2026-10-18T10:03:50.000Z"
        }))
        await Effect.runPromise(recordStep(db, {
          runId: "attempt-score-1",
          name: "fix",
          attempt: 2,
          status: "passed",
          started: "2026-10-18T10:06:00.000Z",
          ended: "2026-10-18T10:06:40.000Z"
        }))
        await Effect.runPromise(recordStepScore(db, {
          runId: "attempt-score-1",
          step: "fix#1",
          score: 2,
          note: "thin",
          scoredAt: "2026-10-18T12:00:00.000Z"
        }))
        const first = await Effect.runPromise(readShow(db, "attempt-score-1"))
        expect(first?.steps[0]?.score).toEqual({ score: 2, note: "thin", scoredAt: "2026-10-18T12:00:00.000Z" })
        expect(first?.steps[1]?.score).toBeNull()
        await Effect.runPromise(recordStepScore(db, {
          runId: "attempt-score-1",
          step: "fix",
          score: 5,
          note: "clearer",
          scoredAt: "2026-10-18T13:00:00.000Z"
        }))
        const second = await Effect.runPromise(readShow(db, "attempt-score-1"))
        expect(second?.steps[0]?.score).toEqual({ score: 2, note: "thin", scoredAt: "2026-10-18T12:00:00.000Z" })
        expect(second?.steps[1]?.score).toEqual({ score: 5, note: "clearer", scoredAt: "2026-10-18T13:00:00.000Z" })
        const refusal = await Effect.runPromise(recordStepScore(db, {
          runId: "attempt-score-1",
          step: "fix#9",
          score: 4,
          note: "",
          scoredAt: "2026-10-18T14:00:00.000Z"
        }).pipe(Effect.flip))
        expect(refusal).toBeInstanceOf(UnknownStep)
      } finally {
        db.close()
      }
    })
  })
})

describe("orc score addresses each resumed checks row", () => {
  test("a step id scores one row when an attempt ran twice after resume", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        await Effect.runPromise(recordRun(db, {
          id: "resume-checks-1",
          project: "orc",
          branch: "orc/demo",
          taskFile: "/tmp/show-home/runs/resume-checks-1/task.md",
          status: "running",
          started: "2026-10-18T10:00:00.000Z"
        }))
        await Effect.runPromise(recordStep(db, {
          runId: "resume-checks-1",
          name: "checks",
          attempt: 1,
          status: "failed",
          started: "2026-10-18T10:01:00.000Z",
          ended: "2026-10-18T10:02:00.000Z"
        }))
        await Effect.runPromise(recordStep(db, {
          runId: "resume-checks-1",
          name: "checks",
          attempt: 2,
          status: "failed",
          started: "2026-10-18T10:03:00.000Z",
          ended: "2026-10-18T10:04:00.000Z"
        }))
        await Effect.runPromise(recordStep(db, {
          runId: "resume-checks-1",
          name: "checks",
          attempt: 1,
          status: "failed",
          started: "2026-10-18T10:10:00.000Z",
          ended: "2026-10-18T10:11:00.000Z"
        }))
        await Effect.runPromise(recordStep(db, {
          runId: "resume-checks-1",
          name: "checks",
          attempt: 2,
          status: "passed",
          started: "2026-10-18T10:12:00.000Z",
          ended: "2026-10-18T10:13:00.000Z"
        }))
        const shown = await Effect.runPromise(readShow(db, "resume-checks-1"))
        expect(shown?.steps.map((step) => step.started)).toEqual([
          "2026-10-18T10:01:00.000Z",
          "2026-10-18T10:03:00.000Z",
          "2026-10-18T10:10:00.000Z",
          "2026-10-18T10:12:00.000Z"
        ])
        const freshFirst = shown?.steps[2]
        if (freshFirst === undefined) {
          throw new Error("missing fresh checks round 1")
        }
        await Effect.runPromise(recordStepScore(db, {
          runId: "resume-checks-1",
          step: freshFirst.id.toString(),
          score: 2,
          note: "fresh first",
          scoredAt: "2026-10-18T14:00:00.000Z"
        }))
        const scored = await Effect.runPromise(readShow(db, "resume-checks-1"))
        expect(scored?.steps[0]?.score).toBeNull()
        expect(scored?.steps[1]?.score).toBeNull()
        expect(scored?.steps[2]?.score).toEqual({ score: 2, note: "fresh first", scoredAt: "2026-10-18T14:00:00.000Z" })
        expect(scored?.steps[3]?.score).toBeNull()
        await Effect.runPromise(recordRun(db, {
          id: "resume-checks-2",
          project: "orc",
          branch: "orc/other",
          taskFile: "/tmp/show-home/runs/resume-checks-2/task.md",
          status: "running",
          started: "2026-10-18T10:00:00.000Z"
        }))
        const crossRun = await Effect.runPromise(recordStepScore(db, {
          runId: "resume-checks-2",
          step: freshFirst.id.toString(),
          score: 5,
          note: "",
          scoredAt: "2026-10-18T15:00:00.000Z"
        }).pipe(Effect.flip))
        expect(crossRun).toBeInstanceOf(UnknownStep)
      } finally {
        db.close()
      }
    })
  })
})
