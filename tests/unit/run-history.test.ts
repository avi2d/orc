import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { BunServices } from "@effect/platform-bun"
import { Effect, Schema } from "effect"
import {
  RUN_HISTORY_SCHEMA_VERSION,
  RUNS_JSON_SCHEMA,
  listRuns,
  openDatabase,
  orcHomeDir,
  recordEvidence,
  recordRun,
  recordScore,
  recordSignal,
  recordStep,
  type RunRecord,
} from "../../packages/run/src/entities/run-history/index"
import { formatRunsTable, runsJson } from "../../packages/run/src/features/seeing-runs/index"

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

const stepsBeforeModel =
  "CREATE TABLE steps (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs (id), name TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1, " +
  "status TEXT NOT NULL CHECK (status IN ('running', 'passed', 'failed', 'skipped')), started TEXT NOT NULL, ended TEXT, agent_file TEXT, pi_session_file TEXT)"

const StepAgentRow = Schema.Struct({ model: Schema.NullOr(Schema.String), thinking: Schema.NullOr(Schema.String) })

const stepAgents = (db: Database): ReadonlyArray<typeof StepAgentRow.Type> =>
  Schema.decodeUnknownSync(Schema.Array(StepAgentRow))(db.query("SELECT model, thinking FROM steps ORDER BY id").all())

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
        "end_reason",
        "sandbox",
        "kind",
        "delivery",
        "task",
        "machine",
        "worktree"
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
        "pi_session_file",
        "model",
        "thinking"
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

  test("a version 1 history gains the sandbox column with no kind for its runs instead of being refused as unsupported", async () => {
    await withHome(async (home) => {
      const v1 = new Database(join(home, "orc.sqlite"), { create: true })
      v1.run("CREATE TABLE runs (id TEXT PRIMARY KEY, project TEXT NOT NULL, branch TEXT NOT NULL, task_file TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')), started TEXT NOT NULL, ended TEXT, pr_link TEXT, end_reason TEXT)")
      v1.run(stepsBeforeModel)
      v1.run("INSERT INTO runs (id, project, branch, task_file, status, started) VALUES ('old-run', 'orc', 'orc/x', 'task.md', 'failed', '2026-10-18T10:00:00.000Z')")
      v1.run("PRAGMA user_version = 1")
      v1.close()
      const db = await openDb(home)
      try {
        expect((await readRuns(db)).map((run) => [run.id, run.sandbox, run.kind, run.delivery])).toEqual([["old-run", null, null, null]])
        expect(columnNames(db, "runs").slice(-6)).toEqual(["sandbox", "kind", "delivery", "task", "machine", "worktree"])
      } finally {
        db.close()
      }
    })
  })

  test("a version 2 history gains the stopped status with its runs intact instead of refusing it", async () => {
    await withHome(async (home) => {
      const v2 = new Database(join(home, "orc.sqlite"), { create: true })
      v2.run("CREATE TABLE runs (id TEXT PRIMARY KEY, project TEXT NOT NULL, branch TEXT NOT NULL, task_file TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')), started TEXT NOT NULL, ended TEXT, pr_link TEXT, end_reason TEXT, sandbox TEXT CHECK (sandbox IN ('nono', 'none')))")
      v2.run(stepsBeforeModel)
      v2.run("INSERT INTO runs (id, project, branch, task_file, status, started, sandbox) VALUES ('old-run', 'orc', 'orc/x', 'task.md', 'running', '2026-10-18T10:00:00.000Z', 'none')")
      v2.run("PRAGMA user_version = 2")
      v2.close()
      const db = await openDb(home)
      try {
        expect((await readRuns(db)).map((run) => [run.id, run.status, run.sandbox])).toEqual([["old-run", "running", "none"]])
        db.run("INSERT INTO runs (id, project, branch, task_file, status, started) VALUES ('stopped-run', 'orc', 'orc/y', 'task.md', 'stopped', '2026-10-18T10:00:00.000Z')")
        expect((await readRuns(db)).map((run) => [run.id, run.status])).toContainEqual(["stopped-run", "stopped"])
      } finally {
        db.close()
      }
    })
  })

  test("a version 3 history gains kind, delivery, task, machine, worktree, model and thinking as null instead of being refused", async () => {
    await withHome(async (home) => {
      const v3 = new Database(join(home, "orc.sqlite"), { create: true })
      v3.run("CREATE TABLE runs (id TEXT PRIMARY KEY, project TEXT NOT NULL, branch TEXT NOT NULL, task_file TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'stopped')), started TEXT NOT NULL, ended TEXT, pr_link TEXT, end_reason TEXT, sandbox TEXT CHECK (sandbox IN ('nono', 'none')))")
      v3.run(stepsBeforeModel)
      v3.run("INSERT INTO runs (id, project, branch, task_file, status, started, sandbox) VALUES ('old-run', 'orc', 'orc/orc-7', 'task.md', 'failed', '2026-10-18T10:00:00.000Z', 'none')")
      v3.run("INSERT INTO steps (run_id, name, status, started, agent_file) VALUES ('old-run', 'implement', 'failed', '2026-10-18T10:00:00.000Z', 'bundled/implementer.md')")
      v3.run("PRAGMA user_version = 3")
      v3.close()
      const db = await openDb(home)
      try {
        expect((await readRuns(db)).map((run) => [run.id, run.kind, run.delivery, run.task, run.machine, run.worktree])).toEqual([["old-run", null, null, null, null, null]])
        expect(stepAgents(db)).toEqual([{ model: null, thinking: null }])
      } finally {
        db.close()
      }
    })
  })

  test("a version 4 history gains task, machine, worktree, model and thinking with its kind kept instead of being refused", async () => {
    await withHome(async (home) => {
      const v4 = new Database(join(home, "orc.sqlite"), { create: true })
      v4.run("CREATE TABLE runs (id TEXT PRIMARY KEY, project TEXT NOT NULL, branch TEXT NOT NULL, task_file TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'stopped')), started TEXT NOT NULL, ended TEXT, pr_link TEXT, end_reason TEXT, sandbox TEXT CHECK (sandbox IN ('nono', 'none')), kind TEXT, delivery TEXT)")
      v4.run(stepsBeforeModel)
      v4.run("INSERT INTO runs (id, project, branch, task_file, status, started, kind, delivery) VALUES ('old-run', 'orc', 'orc/orc-7', 'task.md', 'succeeded', '2026-10-18T10:00:00.000Z', 'ship', 'no-mistakes')")
      v4.run("INSERT INTO steps (run_id, name, status, started) VALUES ('old-run', 'implement', 'passed', '2026-10-18T10:00:00.000Z')")
      v4.run("PRAGMA user_version = 4")
      v4.close()
      const db = await openDb(home)
      try {
        expect((await readRuns(db)).map((run) => [run.kind, run.delivery, run.task, run.machine, run.worktree])).toEqual([["ship", "no-mistakes", null, null, null]])
        expect(stepAgents(db)).toEqual([{ model: null, thinking: null }])
        expect(columnNames(db, "steps").slice(-2)).toEqual(["model", "thinking"])
      } finally {
        db.close()
      }
    })
  })

  test("refuses a sandbox kind orc does not know instead of storing it", async () => {
    await openTemp(async (_home, db) => {
      expect(() =>
        db.run("INSERT INTO runs (id, project, branch, task_file, status, started, sandbox) VALUES ('r', 'orc', 'orc/x', 'task.md', 'running', '2026-10-18T10:00:00.000Z', 'docker')")
      ).toThrow()
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

describe("orcHomeDir", () => {
  test("defaults to ~/.orc", () => {
    expect(orcHomeDir()).toBe(`${homedir()}/.orc`)
  })

  test("an override names the run-history directory", () => {
    expect(orcHomeDir("/tmp/orc-elsewhere")).toBe("/tmp/orc-elsewhere")
  })

  test("an empty override falls back to ~/.orc", () => {
    expect(orcHomeDir("")).toBe(`${homedir()}/.orc`)
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
        endReason: "pr opened",
        task: "orc-12",
        machine: "linux",
        worktree: "/work/orc-12"
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
        endReason: "pr opened",
        task: "orc-12",
        machine: "linux",
        worktree: "/work/orc-12"
      })
      expect(runs.find((run) => run.id === "run-new")).toMatchObject({ task: null, machine: null, worktree: null })
    })
  })

  test("a step keeps the model and thinking it was recorded with instead of dropping them", async () => {
    await openTemp(async (_home, db) => {
      Effect.runSync(recordRun(db, { id: "run-1", project: "orc", branch: "orc/x", taskFile: "task.md", status: "running", started: "2026-10-18T10:00:00.000Z" }))
      Effect.runSync(recordStep(db, { runId: "run-1", name: "implement", attempt: 1, status: "running", started: "2026-10-18T10:00:00.000Z", model: "acme/coder", thinking: "high" }))
      Effect.runSync(recordStep(db, { runId: "run-1", name: "checks", attempt: 1, status: "running", started: "2026-10-18T10:01:00.000Z" }))
      expect(stepAgents(db)).toEqual([{ model: "acme/coder", thinking: "high" }, { model: null, thinking: null }])
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
      endReason: null,
      sandbox: "nono",
      kind: "ship",
      delivery: null,
      task: null,
      machine: null,
      worktree: null
    }
  ]

  const facts = listed.map((run) => ({ run, title: "Fix the gate", step: { id: 4, name: "checks", attempt: 2, status: "failed" as const }, questions: 0, state: "succeeded" as const, currentStep: null }))

  test("names the schema version first, then the runs", () => {
    const document = runsJson(facts)
    expect(Object.keys(document)).toEqual(["schema", "runs"])
    expect(document.schema).toBe(RUNS_JSON_SCHEMA)
    expect(document.schema).toBe("orc.runs.v1")
  })

  test("carries the listed facts for every run", () => {
    const document = runsJson(facts)
    expect(document.runs).toHaveLength(1)
    expect(Object.keys(document.runs[0] ?? {})).toEqual(["id", "project", "branch", "status", "state", "prLink", "title", "step", "currentStep", "questions", "endReason", "kind", "delivery", "task", "machine", "worktree"])
    expect(document.runs[0]).toEqual({
      id: "run-1",
      project: "orc",
      branch: "orc/x",
      status: "succeeded",
      state: "succeeded",
      prLink: "https://github.com/avi2d/orc/pull/1",
      title: "Fix the gate",
      step: { id: 4, name: "checks", attempt: 2, status: "failed" },
      currentStep: null,
      questions: 0,
      endReason: null,
      kind: "ship",
      delivery: null,
      task: null,
      machine: null,
      worktree: null
    })
  })

  test("a JSON round trip keeps the version first", () => {
    const text = JSON.stringify(runsJson(facts))
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
        endReason: null,
        sandbox: "nono",
        kind: null,
        delivery: null,
        task: null,
        machine: null,
        worktree: null
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

  test("lines end at their last cell, as column -t prints them", () => {
    const run: RunRecord = {
      id: "run-1",
      project: "orc",
      branch: "orc/x",
      taskFile: "task.md",
      status: "running",
      started: "2026-10-18T10:00:00.000Z",
      ended: null,
      prLink: null,
      endReason: null,
      sandbox: "nono",
      kind: null,
      delivery: null,
      task: null,
      machine: null,
      worktree: null
    }
    const table = formatRunsTable([run, { ...run, id: "run-2", prLink: "https://github.com/avi2d/orc/pull/1" }])
    expect(table.split("\n")).toEqual([
      "ID     PROJECT  BRANCH  STATUS   PR",
      "run-1  orc      orc/x   running  -",
      "run-2  orc      orc/x   running  https://github.com/avi2d/orc/pull/1"
    ])
  })
})
