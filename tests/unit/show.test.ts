import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Database } from "bun:sqlite"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import {
  decodeRunsJson,
  encodeRunsJson,
  listRuns,
  openDatabase,
  recordEvidence,
  recordRun,
  recordScore,
  recordSignal,
  recordStep
} from "../../src/run-history"
import { decodeShowJson, encodeShowJson, formatShow, readShow } from "../../src/show"

const withHome = async (use: (home: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), "orc-show-"))
  try {
    await use(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const openDb = (home: string): Promise<Database> =>
  Effect.runPromise(openDatabase(home).pipe(Effect.provide(BunServices.layer)))

const fixture = async (db: Database): Promise<void> => {
  await Effect.runPromise(recordRun(db, {
    id: "show-1",
    project: "orc",
    branch: "orc/demo",
    taskFile: "/tmp/show-home/runs/show-1/task.md",
    status: "succeeded",
    started: "2026-10-18T10:00:00.000Z",
    ended: "2026-10-18T10:05:00.000Z",
    prLink: "https://github.com/avi2d/orc/pull/7",
    endReason: "done"
  }))
  const implement = await Effect.runPromise(recordStep(db, {
    runId: "show-1",
    name: "implement",
    attempt: 1,
    status: "passed",
    started: "2026-10-18T10:00:00.000Z",
    ended: "2026-10-18T10:01:00.000Z",
    agentFile: "bundled/implementer.md",
    piSessionFile: "/tmp/show-home/runs/show-1/sessions/x.jsonl"
  }))
  await Effect.runPromise(recordEvidence(db, { stepId: implement, direction: "in", path: "/tmp/show-home/runs/show-1/task.md", kind: "task" }))
  await Effect.runPromise(recordEvidence(db, { stepId: implement, direction: "out", path: "/tmp/show-home/runs/show-1/implement-1.md", kind: "evidence" }))
  await Effect.runPromise(recordSignal(db, { stepId: implement, name: "commit-count", value: "2" }))
  await Effect.runPromise(recordScore(db, { stepId: implement, score: 5, note: "clean", scoredAt: "2026-10-18T11:00:00.000Z" }))
  const checks = await Effect.runPromise(recordStep(db, {
    runId: "show-1",
    name: "checks",
    attempt: 1,
    status: "passed",
    started: "2026-10-18T10:02:00.000Z",
    ended: "2026-10-18T10:03:00.000Z"
  }))
  await Effect.runPromise(recordEvidence(db, { stepId: checks, direction: "out", path: "/tmp/show-home/runs/show-1/checks-1.txt", kind: "checks" }))
  await Effect.runPromise(recordSignal(db, { stepId: checks, name: "check lint", value: "passed" }))
}

describe("readShow", () => {
  test("an unknown run id reads as null", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const document = await Effect.runPromise(readShow(db, "missing"))
        expect(document).toBeNull()
      } finally {
        db.close()
      }
    })
  })

  test("a recorded run reads step by step with signals, score and evidence", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        await fixture(db)
        const document = await Effect.runPromise(readShow(db, "show-1"))
        expect(document?.run).toMatchObject({ id: "show-1", project: "orc", branch: "orc/demo", status: "succeeded" })
        expect(document?.run.prLink).toBe("https://github.com/avi2d/orc/pull/7")
        expect(document?.run.taskFileUrl).toBe("file:///tmp/show-home/runs/show-1/task.md")
        expect(document?.run.reportUrl).toBe("file:///tmp/show-home/runs/show-1/report.md")
        expect(document?.steps.map((step) => step.name)).toEqual(["implement", "checks"])
        const implement = document?.steps[0]
        expect(implement?.signals).toEqual([{ name: "commit-count", value: "2" }])
        expect(implement?.score).toEqual({ score: 5, note: "clean", scoredAt: "2026-10-18T11:00:00.000Z" })
        expect(implement?.evidence.map((item) => item.fileUrl)).toEqual([
          "file:///tmp/show-home/runs/show-1/task.md",
          "file:///tmp/show-home/runs/show-1/implement-1.md"
        ])
        expect(document?.steps[1]?.score).toBeNull()
      } finally {
        db.close()
      }
    })
  })
})

describe("readShow orders and links", () => {
  test("steps read in execution order even when a fix was recorded after the recheck it caused", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        await fixture(db)
        await Effect.runPromise(recordStep(db, {
          runId: "show-1",
          name: "checks",
          attempt: 2,
          status: "passed",
          started: "2026-10-18T10:04:00.000Z",
          ended: "2026-10-18T10:04:30.000Z"
        }))
        await Effect.runPromise(recordStep(db, {
          runId: "show-1",
          name: "fix",
          attempt: 1,
          status: "passed",
          started: "2026-10-18T10:03:10.000Z",
          ended: "2026-10-18T10:03:50.000Z"
        }))
        const document = await Effect.runPromise(readShow(db, "show-1"))
        expect(document?.steps.map((step) => step.name + " " + step.attempt.toString())).toEqual(["implement 1", "checks 1", "fix 1", "checks 2"])
      } finally {
        db.close()
      }
    })
  })

  test("a '#' in a path is escaped so the link names the file rather than a fragment", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        await Effect.runPromise(recordRun(db, {
          id: "hash-1",
          project: "orc",
          branch: "orc/demo",
          taskFile: "/Users/alex#work/.orc/runs/hash-1/task.md",
          status: "failed",
          started: "2026-10-18T10:00:00.000Z",
          ended: "2026-10-18T10:05:00.000Z",
          prLink: null,
          endReason: "done"
        }))
        const document = await Effect.runPromise(readShow(db, "hash-1"))
        expect(document?.run.taskFileUrl).toBe("file:///Users/alex%23work/.orc/runs/hash-1/task.md")
        expect(document?.run.reportUrl).toBe("file:///Users/alex%23work/.orc/runs/hash-1/report.md")
      } finally {
        db.close()
      }
    })
  })
})

describe("show JSON", () => {
  test("the schema field comes first and the document round trips", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        await fixture(db)
        const document = await Effect.runPromise(readShow(db, "show-1"))
        if (document === null) {
          throw new Error("missing fixture")
        }
        const text = await Effect.runPromise(encodeShowJson(document))
        expect(text.startsWith('{"schema":"orc.show.v1"')).toBe(true)
        const decoded = await Effect.runPromise(decodeShowJson(JSON.parse(text)))
        expect(decoded.run.id).toBe("show-1")
        expect(decoded.steps).toHaveLength(2)
      } finally {
        db.close()
      }
    })
  })

  test("the runs document keeps the version first through its own schema", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        await fixture(db)
        const runs = await Effect.runPromise(listRuns(db))
        const text = await Effect.runPromise(encodeRunsJson(runs))
        expect(text.startsWith('{"schema":"orc.runs.v1"')).toBe(true)
        const decoded = await Effect.runPromise(decodeRunsJson(JSON.parse(text)))
        expect(decoded.schema).toBe("orc.runs.v1")
        expect(decoded.runs.map((run) => run.id)).toEqual(["show-1"])
      } finally {
        db.close()
      }
    })
  })
})

describe("formatShow", () => {
  test("every file prints as a full file link beside its result, signals and score", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        await fixture(db)
        const document = await Effect.runPromise(readShow(db, "show-1"))
        if (document === null) {
          throw new Error("missing fixture")
        }
        const text = formatShow(document)
        expect(text).toContain("step implement #1: passed")
        expect(text).toContain("step checks #1: passed")
        expect(text).toContain("signal commit-count: 2")
        expect(text).toContain("signal check lint: passed")
        expect(text).toContain("score: 5 clean (2026-10-18T11:00:00.000Z)")
        expect(text).toContain("file:///tmp/show-home/runs/show-1/task.md")
        expect(text).toContain("file:///tmp/show-home/runs/show-1/report.md")
        expect(text).toContain("file:///tmp/show-home/runs/show-1/checks-1.txt")
        expect(text).toMatch(/^  agent: file:\/\/\/\S+\/bundled\/implementer\.md$/m)
        expect(text).toContain("  session: file:///tmp/show-home/runs/show-1/sessions/x.jsonl")
        expect(text).toContain("https://github.com/avi2d/orc/pull/7")
      } finally {
        db.close()
      }
    })
  })

  test("a score with an empty note prints the score and its time with single spaces", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        await fixture(db)
        const document = await Effect.runPromise(readShow(db, "show-1"))
        if (document === null) {
          throw new Error("missing fixture")
        }
        const checks = document.steps[1]
        if (checks === undefined) {
          throw new Error("missing checks step")
        }
        const unnoted = { ...document, steps: [{ ...checks, score: { score: 3, note: "", scoredAt: "2026-10-20T10:05:00Z" } }] }
        expect(formatShow(unnoted)).toContain("  score: 3 (2026-10-20T10:05:00Z)")
      } finally {
        db.close()
      }
    })
  })
})
