import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { BunServices } from "@effect/platform-bun"
import { Effect, Schema } from "effect"
import {
  RUN_HISTORY_SCHEMA_VERSION,
  RUNS_JSON_SCHEMA,
  formatRunsTable,
  listRuns,
  openDatabase,
  recordEvidence,
  recordRun,
  recordScore,
  recordSignal,
  recordStep,
  runsJson,
  type RunRecord,
} from "../../src/run-history"

const withHome = async (use: (home: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), "orc-home-"))
  try {
    await use(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const openDb = (home: string): Promise<Database> =>
  Effect.runPromise(openDatabase(home).pipe(Effect.provide(BunServices.layer)))

const readRuns = (db: Database): Promise<ReadonlyArray<RunRecord>> => Effect.runPromise(listRuns(db))

const openTemp = async (use: (home: string, db: Database) => Promise<void>): Promise<void> => {
  await withHome(async (home) => {
    const db = await openDb(home)
    try {
      await use(home, db)
    } finally {
      db.close()
    }
  })
}

const NameRow = Schema.Struct({ name: Schema.String })

const tableNames = (db: Database): Array<string> =>
  Schema.decodeUnknownSync(Schema.Array(NameRow))(
    db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  ).map((row) => row.name)

const columnNames = (db: Database, table: string): Array<string> =>
  Schema.decodeUnknownSync(Schema.Array(NameRow))(db.query(`PRAGMA table_info (${table})`).all()).map((row) => row.name)

describe("openDatabase", () => {
  test("creates the home folder, the sqlite file and exactly the five tables", async () => {
    await withHome(async (home) => {
      const nested = join(home, "nested")
      const db = await openDb(nested)
      db.close()
      expect((await stat(join(nested, "orc.sqlite"))).isFile()).toBe(true)
      const reopened = await openDb(nested)
      try {
        expect(tableNames(reopened)).toEqual(["evidence", "runs", "scores", "signals", "steps"])
      } finally {
        reopened.close()
      }
    })
  })

  test("columns match the report field lists", async () => {
    await openTemp(async (_home, db) => {
      expect(columnNames(db, "runs")).toEqual([
        "id",
        "project",
        "branch",
        "task_file",
        "status",
        "started",
        "ended",
        "pr_link",
        "end_reason"
      ])
      expect(columnNames(db, "steps")).toEqual([
        "id",
        "run_id",
        "name",
        "attempt",
        "status",
        "started",
        "ended",
        "agent_file",
        "pi_session_file"
      ])
      expect(columnNames(db, "evidence")).toEqual(["id", "step_id", "direction", "path", "kind"])
      expect(columnNames(db, "signals")).toEqual(["id", "step_id", "name", "value"])
      expect(columnNames(db, "scores")).toEqual(["id", "step_id", "score", "note", "scored_at"])
    })
  })

  test("keeps a schema version the next migration can read", async () => {
    await openTemp(async (_home, db) => {
      const version = Schema.decodeUnknownSync(Schema.Struct({ user_version: Schema.Finite }))(
        db.query("PRAGMA user_version").get()
      ).user_version
      expect(version).toBe(RUN_HISTORY_SCHEMA_VERSION)
    })
  })

  test("refuses a file stamped by a newer schema", async () => {
    await withHome(async (home) => {
      const db = await openDb(home)
      db.run(`PRAGMA user_version = ${RUN_HISTORY_SCHEMA_VERSION + 1}`)
      db.close()
      const message = await Effect.runPromise(
        openDatabase(home).pipe(
          Effect.provide(BunServices.layer),
          Effect.catchTag("UnsupportedSchemaVersion", (cause) =>
            Effect.succeed(`unsupported schema version ${cause.found}`)
          ),
          Effect.catch((cause) => Effect.succeed(`another failure: ${String(cause)}`))
        )
      )
      expect(message).toContain("unsupported schema version")
    })
  })

  test("a file that is not a database fails as a SqliteFailure", async () => {
    await withHome(async (home) => {
      await writeFile(join(home, "orc.sqlite"), "this is not a sqlite database ".repeat(8))
      const message = await Effect.runPromise(
        openDatabase(home).pipe(
          Effect.provide(BunServices.layer),
          Effect.as("opened"),
          Effect.catchTag("SqliteFailure", (failure) => Effect.succeed(`sqlite failure: ${String(failure.cause)}`)),
          Effect.catch((cause) => Effect.succeed(`another failure: ${String(cause)}`))
        )
      )
      expect(message).toContain("sqlite failure")
      expect(message).toContain("file is not a database")
    })
  })
})

describe("record and list runs", () => {
  test("lists runs newest first with every recorded field", async () => {
    await openTemp(async (_home, db) => {
      Effect.runSync(recordRun(db, {
        id: "run-old",
        project: "orc",
        branch: "orc/old",
        taskFile: "task.md",
        status: "succeeded",
        started: "2026-10-16T10:00:00.000Z",
        ended: "2026-10-16T10:05:00.000Z",
        prLink: "https://github.com/avi2d/orc/pull/1",
        endReason: "pr opened"
      }))
      Effect.runSync(recordRun(db, {
        id: "run-new",
        project: "orc",
        branch: "orc/new",
        taskFile: "task.md",
        status: "running",
        started: "2026-10-17T10:00:00.000Z"
      }))
      const runs = await readRuns(db)
      expect(runs.map((run) => run.id)).toEqual(["run-new", "run-old"])
      const finished = runs.find((run) => run.id === "run-old")
      expect(finished).toMatchObject({
        project: "orc",
        branch: "orc/old",
        taskFile: "task.md",
        status: "succeeded",
        ended: "2026-10-16T10:05:00.000Z",
        prLink: "https://github.com/avi2d/orc/pull/1",
        endReason: "pr opened"
      })
    })
  })

  test("records steps, evidence, signals and scores against their parents", async () => {
    await openTemp(async (_home, db) => {
      Effect.runSync(recordRun(db, {
        id: "run-1",
        project: "orc",
        branch: "orc/x",
        taskFile: "task.md",
        status: "running",
        started: "2026-10-18T10:00:00.000Z"
      }))
      const stepId = Effect.runSync(recordStep(db, {
        runId: "run-1",
        name: "implement",
        attempt: 1,
        status: "passed",
        started: "2026-10-18T10:01:00.000Z",
        ended: "2026-10-18T10:02:00.000Z",
        agentFile: "implementer.md",
        piSessionFile: "session.jsonl"
      }))
      Effect.runSync(recordEvidence(db, { stepId, direction: "in", path: "task.md", kind: "task" }))
      Effect.runSync(recordSignal(db, { stepId, name: "commits", value: "2" }))
      Effect.runSync(recordScore(db, { stepId, score: 5, note: "clean", scoredAt: "2026-10-18T11:00:00.000Z" }))
      const steps = db.query("SELECT run_id, name, status FROM steps").all()
      expect(steps).toEqual([{ run_id: "run-1", name: "implement", status: "passed" }])
      expect(db.query("SELECT direction, path FROM evidence").all()).toEqual([{ direction: "in", path: "task.md" }])
      expect(db.query("SELECT name, value FROM signals").all()).toEqual([{ name: "commits", value: "2" }])
      expect(db.query("SELECT score, note FROM scores").all()).toEqual([{ score: 5, note: "clean" }])
    })
  })

  test("the database rejects a run status outside the union", async () => {
    await openTemp(async (_home, db) => {
      expect(() =>
        db.query("INSERT INTO runs (id, project, branch, task_file, status, started) VALUES (?, ?, ?, ?, ?, ?)").run(
          "run-bad",
          "orc",
          "orc/bad",
          "task.md",
          "done",
          "2026-10-18T10:00:00.000Z"
        )
      ).toThrow()
    })
  })

  test("rejects a score outside 1 to 5", async () => {
    await openTemp(async (_home, db) => {
      Effect.runSync(recordRun(db, {
        id: "run-1",
        project: "orc",
        branch: "orc/x",
        taskFile: "task.md",
        status: "running",
        started: "2026-10-18T10:00:00.000Z"
      }))
      const stepId = Effect.runSync(recordStep(db, {
        runId: "run-1",
        name: "implement",
        attempt: 1,
        status: "passed",
        started: "2026-10-18T10:00:00.000Z"
      }))
      expect(() =>
        db.query("INSERT INTO scores (step_id, score, note, scored_at) VALUES (?, ?, ?, ?)").run(
          stepId,
          6,
          "too high",
          "2026-10-18T11:00:00.000Z"
        )
      ).toThrow()
    })
  })
})

describe("runsJson", () => {
  const listed: ReadonlyArray<RunRecord> = [
    {
      id: "run-1",
      project: "orc",
      branch: "orc/x",
      taskFile: "task.md",
      status: "succeeded",
      started: "2026-10-18T10:00:00.000Z",
      ended: "2026-10-18T10:05:00.000Z",
      prLink: "https://github.com/avi2d/orc/pull/1",
      endReason: null
    }
  ]

  test("names the schema version first, then the runs", () => {
    const document = runsJson(listed)
    expect(Object.keys(document)).toEqual(["schema", "runs"])
    expect(document.schema).toBe(RUNS_JSON_SCHEMA)
    expect(document.schema).toBe("orc.runs.v1")
  })

  test("carries the listed facts for every run", () => {
    const document = runsJson(listed)
    expect(document.runs).toHaveLength(1)
    expect(Object.keys(document.runs[0] ?? {})).toEqual(["id", "project", "branch", "status", "prLink"])
    expect(document.runs[0]).toEqual({
      id: "run-1",
      project: "orc",
      branch: "orc/x",
      status: "succeeded",
      prLink: "https://github.com/avi2d/orc/pull/1"
    })
  })

  test("a JSON round trip keeps the version first", () => {
    const text = JSON.stringify(runsJson(listed))
    expect(text.startsWith('{"schema":"orc.runs.v1"')).toBe(true)
    const document = Schema.decodeUnknownSync(Schema.Struct({ schema: Schema.String }))(JSON.parse(text))
    expect(Object.keys(document)[0]).toBe("schema")
    expect(document.schema).toBe("orc.runs.v1")
  })
})

describe("formatRunsTable", () => {
  test("an empty history says so", () => {
    expect(formatRunsTable([])).toBe("no runs recorded")
  })

  test("lists each run with its project, branch, status and PR link", () => {
    const table = formatRunsTable([
      {
        id: "run-1",
        project: "orc",
        branch: "orc/x",
        taskFile: "task.md",
        status: "running",
        started: "2026-10-18T10:00:00.000Z",
        ended: null,
        prLink: null,
        endReason: null
      }
    ])
    const [header, row] = table.split("\n")
    expect(header).toContain("PROJECT")
    expect(header).toContain("BRANCH")
    expect(header).toContain("STATUS")
    expect(header).toContain("PR")
    expect(row).toContain("orc")
    expect(row).toContain("orc/x")
    expect(row).toContain("running")
  })
})
