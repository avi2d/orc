import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Database } from "bun:sqlite"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { AgentFile } from "../../packages/run/src/entities/agent/index"
import { openDatabase, recordRun, recordSignal, recordStep } from "../../packages/run/src/entities/run-history/index"
import { recordChecksDone, recordResumePublish } from "../../packages/run/src/history-write"
import { buildResumePlan } from "../../packages/run/src/run-resume"
import { subprocessNoMistakesRunner } from "../../packages/run/src/entities/review-gate/no-mistakes"
import type { HistoryRun } from "../../packages/run/src/run-record"
import { runChecksRound } from "../../packages/run/src/checks"
import { type CommandResult } from "../../packages/run/src/shared/sandbox/agent-exec"
import {
  decodeRefusalsJson,
  refusalsJson,
  encodeRefusalsJson,
  formatRefusalsTable,
  readRefusals,
  refusalsIn,
  refusalValue,
  type GateRefusal,
} from "../../packages/run/src/entities/run-history/index"

const lintOutput = [
  "comment-gate: 1 violation(s):",
  "  src/a.ts:1 carries the machine-read directive `x`. Fix it",
  "secrets: CHECKS_SECRETS_PACK is unset, so the kit's rules ran without a private pack",
  "docs: no line the range adds or edits copies a version package.json or .bun-version pins",
  "checks-lint: 1 of 9 gate(s) failed: checks-comment-gate",
].join("\n")

const oxlintOutput = [
  "src/a.ts:2:1: error eslint(no-debugger): `debugger` statement is not allowed help: Remove the debugger statement",
  "src/b.ts:3:4: error eslint(no-debugger): `debugger` statement is not allowed help: Remove the debugger statement",
  "src/c.ts:1:1: error eslint(no-cond-assign): Expected a conditional expression and instead saw an assignment help: Consider wrapping the assignment in additional parentheses",
].join("\n")

describe("refusalsIn", () => {
  test("records the failed kit gate instead of parsing its wording", () => {
    expect(refusalsIn(lintOutput, "lint")).toEqual([{ gate: "comment-gate", rule: null }])
  })

  test("records each failed kit gate once instead of merging them", () => {
    const output = [
      "docs: 1 violation(s):",
      "  docs/a.md:4: names `foo.ts`, which is not in the repository",
      "comment-gate: 1 violation(s):",
      "  src/a.ts:1 carries the machine-read directive `x`. Fix it",
      "checks-lint: 2 of 9 gate(s) failed: checks-docs, checks-comment-gate",
    ].join("\n")
    expect(refusalsIn(output, "lint")).toEqual([
      { gate: "docs", rule: null },
      { gate: "comment-gate", rule: null },
    ])
  })

  test("records the oxlint rule code instead of the file and message", () => {
    expect(refusalsIn(oxlintOutput, "lint")).toEqual([
      { gate: "lint", rule: "eslint(no-debugger)" },
      { gate: "lint", rule: "eslint(no-cond-assign)" },
    ])
  })

  test("records the error code instead of an oxlint warning", () => {
    const output = [
      "src/a.ts:2:1: error eslint(no-debugger): `debugger` statement is not allowed help: Remove the debugger statement",
      "src/b.ts:2:5: warning eslint(no-unused-vars): `x` is defined but never used help: Remove the unused variable",
    ].join("\n")
    expect(refusalsIn(output, "lint")).toEqual([{ gate: "lint", rule: "eslint(no-debugger)" }])
  })

  test("records the tsc rule code instead of the message", () => {
    const output = "src/a.ts(1,2): error TS1234: this type is not assignable"
    expect(refusalsIn(output, "typecheck")).toEqual([{ gate: "typecheck", rule: "TS1234" }])
  })

  test("ignores a diagnostic string inside bun context lines instead of recording it", () => {
    const output = [
      "tests/unit/gate-refusals.test.ts:",
      "41 | const output = \"src/a.ts(1,2): error TS1234: this type is not assignable\"",
      "error: expect(received).toBe(expected)",
    ].join("\n")
    expect(refusalsIn(output, "test")).toEqual([{ gate: "test", rule: null }])
  })

  test("records the failing test command instead of parsing bun output", () => {
    const output = "checks-test: bun test failed before it wrote a report, so no skip was judged"
    expect(refusalsIn(output, "test")).toEqual([{ gate: "test", rule: null }])
  })

  test("records the check name when the output names no gate", () => {
    expect(refusalsIn("", "lint")).toEqual([{ gate: "lint", rule: null }])
    expect(refusalsIn("something odd\n", "lint")).toEqual([{ gate: "lint", rule: null }])
  })
})

describe("runChecksRound refusals", () => {
  test("attaches the kit refusal to the failed check and none to the pass", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-refusals-"))
    try {
      const runCommand = (command: string): Effect.Effect<CommandResult> =>
        Effect.succeed(command === "bun run lint" ? { stdout: lintOutput, stderr: "", exitCode: 1 } : { stdout: "ok", stderr: "", exitCode: 0 })
      const round = await Effect.runPromise(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        return yield* runChecksRound(runCommand, fs, path, dir, 1, [
          { name: "lint", command: "bun run lint" },
          { name: "typecheck", command: "bun run typecheck" },
        ])
      }).pipe(Effect.provide(BunServices.layer)))
      expect(round.outcomes[0]?.refusals).toEqual([{ gate: "comment-gate", rule: null }])
      expect(round.outcomes[1]?.refusals).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

const openDb = (home: string): Promise<Database> =>
  Effect.runPromise(openDatabase(home).pipe(Effect.provide(BunServices.layer)))

const recordRefusal = (db: Database, runId: string, attempt: number, refusal: GateRefusal): Promise<void> =>
  Effect.runPromise(Effect.gen(function*() {
    const stepId = yield* recordStep(db, {
      runId,
      name: "checks",
      attempt,
      status: "failed",
      started: "2026-01-01T00:00:00.000Z",
      ended: "2026-01-01T00:01:00.000Z",
      agentFile: null,
      piSessionFile: null,
    })
    yield* recordSignal(db, { stepId, name: "refusal", value: refusalValue(refusal) })
  }))

const seedRuns = async (db: Database): Promise<void> => {
  for (const runId of ["run-1", "run-2"]) {
    await Effect.runPromise(recordRun(db, {
      id: runId,
      project: "/repo",
      branch: "orc/" + runId,
      taskFile: "/repo/task.md",
      status: "failed",
      started: "2026-01-01T00:00:00.000Z",
    }))
  }
  await recordRefusal(db, "run-1", 1, { gate: "comment-gate", rule: null })
  await recordRefusal(db, "run-1", 2, { gate: "comment-gate", rule: null })
  await recordRefusal(db, "run-2", 1, { gate: "comment-gate", rule: null })
  await recordRefusal(db, "run-2", 1, { gate: "docs", rule: null })
}

describe("readRefusals", () => {
  test("counts one run once when two rounds hit the same refusal", async () => {
    const home = await mkdtemp(join(tmpdir(), "orc-refusals-db-"))
    try {
      const db = await openDb(home)
      try {
        await seedRuns(db)
        expect(await Effect.runPromise(readRefusals(db))).toEqual([
          { gate: "comment-gate", rule: null, runs: 2 },
          { gate: "docs", rule: null, runs: 1 },
        ])
      } finally {
        db.close()
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("reads no refusals from an empty history", async () => {
    const home = await mkdtemp(join(tmpdir(), "orc-refusals-empty-"))
    try {
      const db = await openDb(home)
      try {
        expect(await Effect.runPromise(readRefusals(db))).toEqual([])
      } finally {
        db.close()
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe("refusals view", () => {
  test("round-trips the refusals document through its schema", async () => {
    const counts = [{ gate: "lint", rule: "eslint(no-debugger)", runs: 2 }]
    expect(refusalsJson(counts)).toEqual({ schema: "orc.refusals.v1", refusals: counts })
    const text = await Effect.runPromise(encodeRefusalsJson(counts))
    expect(text).toContain("orc.refusals.v1")
    expect(text).toContain("\"gate\"")
    expect(text).toContain("\"rule\"")
    expect(text).toContain("\"runs\"")
    const decoded = await Effect.runPromise(decodeRefusalsJson(JSON.parse(text)))
    expect(decoded.schema).toBe("orc.refusals.v1")
    expect(decoded.refusals).toEqual(counts)
  })

  test("prints one row per refusal and names the empty ledger", () => {
    const table = formatRefusalsTable([
      { gate: "lint", rule: "eslint(no-debugger)", runs: 2 },
      { gate: "comment-gate", rule: null, runs: 1 },
    ])
    const head = table.split("\n")[0]
    expect(head.startsWith("GATE")).toBe(true)
    expect(head).toContain("RULE")
    expect(head.endsWith("RUNS")).toBe(true)
    expect(table).toContain("lint")
    expect(table).toContain("eslint(no-debugger)")
    expect(table).toContain("comment-gate")
    expect(table).toContain("\u2014")
    expect(formatRefusalsTable([])).toBe("no gate refusals recorded")
  })
})

describe("resumed refusals", () => {
  test("counts a resumed refusal once instead of republishing it under the new run", async () => {
    const home = await mkdtemp(join(tmpdir(), "orc-refusals-resume-"))
    try {
      const db = await openDb(home)
      try {
        const project = join(home, "repo")
        const priorDir = join(home, "runs", "prior-1")
        await mkdir(priorDir, { recursive: true })
        await writeFile(join(priorDir, "task.md"), "Do the thing.\n")
        await writeFile(join(priorDir, "checks-1.md"), "checks\n")
        await Effect.runPromise(recordRun(db, {
          id: "prior-1", project, branch: "orc/test", taskFile: join(priorDir, "task.md"),
          status: "failed", started: "2026-10-19T09:00:00.000Z"
        }).pipe(Effect.asVoid))
        await Effect.runPromise(recordStep(db, {
          runId: "prior-1", name: "implement", attempt: 1, status: "passed",
          started: "2026-10-19T09:00:00.000Z", agentFile: "bundled/implementer.md", piSessionFile: null
        }).pipe(Effect.asVoid))
        await Effect.runPromise(recordChecksDone(db, "prior-1", {
          round: 1, file: join(priorDir, "checks-1.md"),
          started: "2026-10-19T09:20:00.000Z", ended: "2026-10-19T09:21:00.000Z",
          passed: false, failed: ["lint"], checks: [{ name: "lint", passed: false }],
          refusals: [{ gate: "comment-gate", rule: null }]
        }))
        const implementer: AgentFile = {
          kind: "implementer", model: "opencode-go/muse-spark", thinking: "high",
          tools: ["read"], body: "Do the task.", path: "bundled/implementer.md", source: "bundled"
        }
        const fixer: AgentFile = {
          kind: "fixer", model: "opencode-go/muse-spark", thinking: "high",
          tools: ["read"], body: "Fix the failure.", path: "bundled/fixer.md", source: "bundled"
        }
        const run = await Effect.runPromise(Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const runId = "next-1"
          const runDir = path.join(home, "runs", runId)
          const history: HistoryRun = {
            fs, path, spawner, git: "git", projectDir: project, runId, runDir,
            piSessionDir: path.join(runDir, "session"),
            hostSessionsDir: path.join(runDir, "sessions"),
            taskPath: path.join(runDir, "task.md"),
            instructions: null, agent: implementer, fixer, branch: "orc/test", sandbox: "nono",
            started: "2026-10-19T10:00:00.000Z", worktreeDir: project,
            delivery: { kind: "no-mistakes", runner: subprocessNoMistakesRunner({ spawner, binary: "no-mistakes", pathEnv: "", git: "git", worktreeDir: project }) },
            allow: [], answers: []
          }
          return history
        }).pipe(Effect.provide(BunServices.layer)))
        const plan = await Effect.runPromise(buildResumePlan(db, run))
        expect(plan.inheritedRounds.length).toBe(1)
        await Effect.runPromise(recordResumePublish(db, run, plan))
        expect(await Effect.runPromise(readRefusals(db))).toEqual([
          { gate: "comment-gate", rule: null, runs: 1 },
        ])
        const resumed = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Finite }))(
          db.query(
            "SELECT COUNT(*) AS count FROM signals JOIN steps ON signals.step_id = steps.id WHERE steps.run_id = ? AND signals.name = ?"
          ).get("next-1", "refusal")
        )
        expect(resumed.count).toBe(0)
      } finally {
        db.close()
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
