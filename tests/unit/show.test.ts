import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Database } from "bun:sqlite"
import { BunServices } from "@effect/platform-bun"
import { Effect, Schema } from "effect"
import {
  listRuns,
  openDatabase,
  recordEvidence,
  recordRun,
  recordScore,
  recordSignal,
  recordStep
} from "../../packages/run/src/entities/run-history/index"
import { recordReviewDone, recordReviewStart } from "../../packages/run/src/features/running-a-task/history-write"
import { decodeRunsJson, decodeShowJson, encodeRunsJson, encodeShowJson, formatShow, InvalidScore, readListedRuns, readRunsJsonRuns, readShow, recordStepScore, runsJson, UnknownRun, UnknownStep } from "../../packages/run/src/features/seeing-runs/index"

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

describe("readShow run and step facts", () => {
  test("orc show JSON carries the run's task, machine and worktree and each step's model and thinking instead of leaving them out", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        await Effect.runPromise(recordRun(db, {
          id: "facts-1", project: "orc", branch: "orc/orc-36", taskFile: "/tmp/facts/task.md", status: "running", started: "2026-10-18T10:00:00.000Z",
          task: "orc-36", machine: "linux", worktree: "/work/orc-36"
        }))
        await Effect.runPromise(recordStep(db, { runId: "facts-1", name: "implement", attempt: 1, status: "passed", started: "2026-10-18T10:00:00.000Z", model: "acme/coder", thinking: "high" }))
        await Effect.runPromise(recordStep(db, { runId: "facts-1", name: "checks", attempt: 1, status: "passed", started: "2026-10-18T10:01:00.000Z" }))
        const document = await Effect.runPromise(readShow(db, "facts-1"))
        if (document === null) {
          throw new Error("missing fixture")
        }
        const decoded = await Effect.runPromise(decodeShowJson(JSON.parse(await Effect.runPromise(encodeShowJson(document)))))
        expect(decoded.run).toMatchObject({ task: "orc-36", machine: "linux", worktree: "/work/orc-36" })
        expect(decoded.steps.map((step) => [step.name, step.model, step.thinking])).toEqual([["implement", "acme/coder", "high"], ["checks", null, null]])
      } finally {
        db.close()
      }
    })
  })

  test("a run recorded without facts shows null task, machine and worktree instead of omitting the keys", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        await fixture(db)
        const document = await Effect.runPromise(readShow(db, "show-1"))
        expect(document?.run).toMatchObject({ task: null, machine: null, worktree: null })
        expect(document?.steps[0]).toMatchObject({ model: null, thinking: null })
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

describe("readShow of a resumed run", () => {
  const carried = async (db: Database, name: string, attempt: number, started: string, out: { readonly path: string; readonly kind: string }): Promise<void> => {
    const stepId = await Effect.runPromise(recordStep(db, { runId: "resumed-b", name, attempt, status: name === "checks" && attempt === 3 ? "passed" : "failed", started, ended: started }))
    await Effect.runPromise(recordEvidence(db, { stepId, direction: "out", ...out }))
  }

  test("a resumed run lists its carried steps from the earlier run before its own, not carried checks sorted before its own agent step", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        const runs = join(home, "runs")
        await Effect.runPromise(recordRun(db, { id: "resumed-b", project: "orc", branch: "orc/demo", taskFile: join(runs, "resumed-b", "task.md"), status: "succeeded", started: "2026-10-18T12:00:00.000Z" }))
        const implement = await Effect.runPromise(recordStep(db, { runId: "resumed-b", name: "implement", attempt: 1, status: "passed", started: "2026-10-18T12:00:00.000Z", ended: "2026-10-18T12:00:00.000Z" }))
        await Effect.runPromise(recordEvidence(db, { stepId: implement, direction: "out", path: join(runs, "resumed-b", "implement-1.md"), kind: "evidence" }))
        await carried(db, "checks", 1, "2026-10-18T10:10:00.000Z", { path: join(runs, "resumed-a", "session", "checks-1.txt"), kind: "checks" })
        await carried(db, "checks", 2, "2026-10-18T10:30:00.000Z", { path: join(runs, "resumed-a", "session", "checks-2.txt"), kind: "checks" })
        await carried(db, "checks", 3, "2026-10-18T10:50:00.000Z", { path: join(runs, "resumed-a", "session", "checks-3.txt"), kind: "checks" })
        await carried(db, "fix", 1, "2026-10-18T10:20:00.000Z", { path: join(runs, "resumed-a", "sessions", "f1.jsonl"), kind: "session" })
        await carried(db, "fix", 2, "2026-10-18T10:40:00.000Z", { path: join(runs, "resumed-a", "fix-2.log"), kind: "log" })
        await Effect.runPromise(recordStep(db, { runId: "resumed-b", name: "no-mistakes", attempt: 1, status: "passed", started: "2026-10-18T12:01:00.000Z" }))
        const document = await Effect.runPromise(readShow(db, "resumed-b"))
        expect(document?.steps.map((step) => [step.name + " " + step.attempt.toString(), step.from])).toEqual([
          ["implement 1", "resumed-a"],
          ["checks 1", "resumed-a"],
          ["fix 1", "resumed-a"],
          ["checks 2", "resumed-a"],
          ["fix 2", "resumed-a"],
          ["checks 3", "resumed-a"],
          ["no-mistakes 1", null]
        ])
      } finally {
        db.close()
      }
    })
  })

  test("a run that carries nothing names no earlier run on its steps", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        await fixture(db)
        const document = await Effect.runPromise(readShow(db, "show-1"))
        expect(document?.steps.map((step) => step.from)).toEqual([null, null])
      } finally {
        db.close()
      }
    })
  })
})

describe("orc score latest wins in orc show", () => {
  test("a later orc score replaces the earlier score in orc show", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        await fixture(db)
        await Effect.runPromise(recordStepScore(db, {
          runId: "show-1",
          step: "implement",
          score: 2,
          note: "thin",
          scoredAt: "2026-10-18T12:00:00.000Z"
        }))
        await Effect.runPromise(recordStepScore(db, {
          runId: "show-1",
          step: "implement",
          score: 5,
          note: "clearer",
          scoredAt: "2026-10-18T13:00:00.000Z"
        }))
        const document = await Effect.runPromise(readShow(db, "show-1"))
        expect(document?.steps[0]?.score).toEqual({ score: 5, note: "clearer", scoredAt: "2026-10-18T13:00:00.000Z" })
        const rows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ score: Schema.Finite })))(db.query("SELECT score FROM scores ORDER BY id ASC").all())
        expect(rows.map((row) => row.score).slice(-2)).toEqual([2, 5])
      } finally {
        db.close()
      }
    })
  })

  test("orc score refuses an unknown run with no write to orc show", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        await fixture(db)
        const failure = await Effect.runPromise(recordStepScore(db, {
          runId: "missing",
          step: "implement",
          score: 4,
          note: "",
          scoredAt: "2026-10-18T12:00:00.000Z"
        }).pipe(Effect.flip))
        expect(failure).toBeInstanceOf(UnknownRun)
        const count = Schema.decodeUnknownSync(Schema.Struct({ total: Schema.Finite }))(db.query("SELECT COUNT(*) AS total FROM scores").get()).total
        expect(count).toBe(1)
      } finally {
        db.close()
      }
    })
  })

  test("orc score refuses an unknown step with no write to orc show", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        await fixture(db)
        const failure = await Effect.runPromise(recordStepScore(db, {
          runId: "show-1",
          step: "missing-step",
          score: 4,
          note: "",
          scoredAt: "2026-10-18T12:00:00.000Z"
        }).pipe(Effect.flip))
        expect(failure).toBeInstanceOf(UnknownStep)
        const count = Schema.decodeUnknownSync(Schema.Struct({ total: Schema.Finite }))(db.query("SELECT COUNT(*) AS total FROM scores").get()).total
        expect(count).toBe(1)
      } finally {
        db.close()
      }
    })
  })

  test("orc score refuses a score outside 1 to 5 with no write to orc show", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        await fixture(db)
        const failure = await Effect.runPromise(recordStepScore(db, {
          runId: "show-1",
          step: "implement",
          score: 6,
          note: "too high",
          scoredAt: "2026-10-18T12:00:00.000Z"
        }).pipe(Effect.flip))
        expect(failure).toBeInstanceOf(InvalidScore)
        const count = Schema.decodeUnknownSync(Schema.Struct({ total: Schema.Finite }))(db.query("SELECT COUNT(*) AS total FROM scores").get()).total
        expect(count).toBe(1)
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
        const runs = await Effect.runPromise(listRuns(db).pipe(Effect.flatMap((listed) => readListedRuns(db, listed)), Effect.flatMap((listed) => readRunsJsonRuns(listed, (runId) => join(home, "runs", runId))), Effect.provide(BunServices.layer)))
        const text = await Effect.runPromise(encodeRunsJson(runsJson(runs)))
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

  test("a recorded review step prints its result, model, minutes, findings and review file", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        await fixture(db)
        const reviewer = { path: "bundled/reviewer.md", model: "acme/reviewer", thinking: "high" as const }
        await Effect.runPromise(recordReviewStart(db, "show-1", reviewer, "2026-10-18T10:03:00.000Z"))
        await Effect.runPromise(recordReviewDone(db, "show-1", reviewer, { status: "passed", findings: [], file: "/tmp/show-home/runs/show-1/review.json", reusedFrom: null }, "2026-10-18T10:03:00.000Z", "2026-10-18T10:05:30.000Z"))
        const document = await Effect.runPromise(readShow(db, "show-1"))
        if (document === null) {
          throw new Error("missing fixture")
        }
        const text = formatShow(document)
        const review = text.split("\n\n").find((block) => block.startsWith("step review #1"))
        expect(review).toContain("step review #1: passed")
        expect(review).toContain("  model: acme/reviewer")
        expect(review).toContain("  minutes: 2.5")
        expect(review).toContain("  signal review-findings: 0")
        expect(review).toContain("  evidence out review: file:///tmp/show-home/runs/show-1/review.json")
      } finally {
        db.close()
      }
    })
  })

  test.each([
    { started: true, status: "passed" as const },
    { started: false, status: "passed" as const },
    { started: true, status: "failed" as const },
    { started: false, status: "failed" as const }
  ])("a reused $status review with start=$started names its earlier run instead of claiming a model ran", async ({ started, status }) => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        await fixture(db)
        const reviewer = { path: "bundled/reviewer.md", model: "acme/reviewer", thinking: "high" as const }
        if (started) {
          await Effect.runPromise(recordReviewStart(db, "show-1", reviewer, "2026-10-18T10:03:00.000Z"))
        }
        const outcome = status === "passed"
          ? { status, findings: [], file: "/tmp/show-home/runs/show-1/review.json", reusedFrom: "earlier-run" }
          : { status, reason: "cannot write review.json", reusedFrom: "earlier-run" }
        await Effect.runPromise(recordReviewDone(db, "show-1", reviewer, outcome, "2026-10-18T10:03:00.000Z", "2026-10-18T10:03:00.000Z"))
        const document = await Effect.runPromise(readShow(db, "show-1"))
        if (document === null) {
          throw new Error("missing fixture")
        }
        const review = document.steps.find((step) => step.name === "review")
        expect(review).toMatchObject({ status, agentFile: null, model: null, thinking: null })
        expect(review?.signals).toContainEqual({ name: "review-reused-from", value: "earlier-run" })
        const block = formatShow(document).split("\n\n").find((part) => part.startsWith("step review #1"))
        expect(block).toContain("  reused from run earlier-run")
        expect(block).not.toContain("  model:")
        expect(document.steps.map((step) => [step.name, step.from])).toEqual([["implement", null], ["checks", null], ["review", null]])
      } finally {
        db.close()
      }
    })
  })

  test("a failed review step records why it failed", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      try {
        await fixture(db)
        const reviewer = { path: "bundled/reviewer.md", model: "acme/reviewer", thinking: "high" as const }
        await Effect.runPromise(recordReviewStart(db, "show-1", reviewer, "2026-10-18T10:03:00.000Z"))
        await Effect.runPromise(recordReviewDone(db, "show-1", reviewer, { status: "failed", reason: "the reply did not stop cleanly", reusedFrom: null }, "2026-10-18T10:03:00.000Z", "2026-10-18T10:04:00.000Z"))
        const document = await Effect.runPromise(readShow(db, "show-1"))
        const review = document?.steps.find((step) => step.name === "review")
        expect(review?.status).toBe("failed")
        expect(review?.model).toBe("acme/reviewer")
        expect(review?.signals).toEqual([{ name: "review-failure", value: "the reply did not stop cleanly" }])
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
        const checks = document.steps.at(1)
        if (checks === undefined) {
          throw new Error("missing checks step")
        }
        const unnoted = { ...document, steps: [{ ...checks, score: { score: 3 as const, note: "", scoredAt: "2026-10-20T10:05:00Z" } }] }
        expect(formatShow(unnoted)).toContain("  score: 3 (2026-10-20T10:05:00Z)")
      } finally {
        db.close()
      }
    })
  })
})
