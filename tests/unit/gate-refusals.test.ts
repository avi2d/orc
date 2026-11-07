import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Database } from "bun:sqlite"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { AgentFile } from "../../packages/run/src/agents"
import { openDatabase, recordRun, recordSignal, recordStep } from "../../packages/run/src/run-history"
import { recordChecksDone, recordResumePublish } from "../../packages/run/src/history-write"
import { buildResumePlan } from "../../packages/run/src/run-resume"
import { subprocessNoMistakesRunner } from "../../packages/run/src/no-mistakes"
import type { HistoryRun } from "../../packages/run/src/run-record"
import { runChecksRound, type CommandResult } from "../../packages/run/src/checks"
import {
  decodeRefusalsJson,
  refusalsJson,
  encodeRefusalsJson,
  formatRefusalsTable,
  readRefusals,
  refusalsIn,
  refusalValue,
  type GateRefusal,
} from "../../packages/run/src/gate-refusals"

const lintOutput = [
  "comment-gate: 1 violation(s):",
  "  src/a.ts:1 carries the machine-read directive `eslint-disable-next-line`. Fix what the tool is reporting, or stop running the tool on this file",
  "checks-lint: 1 of 2 gate(s) failed: checks-comment-gate",
].join("\n")

const directiveRule = "carries the machine-read directive `eslint-disable-next-line`. Fix what the tool is reporting, or stop running the tool on this file"

describe("refusalsIn", () => {
  test("keeps the kit gate instead of the check command name", () => {
    expect(refusalsIn(lintOutput)).toEqual([{ gate: "comment-gate", rule: directiveRule }])
  })

  test("merges the checks- bin spelling with the gate header spelling", () => {
    const output = [
      "docs: 2 violation(s):",
      "  docs/guide.md:3 point at the words, not the page",
      "  docs/other.md:7 point at the words, not the page",
      "checks-lint: 1 of 3 gate(s) failed: checks-docs",
    ].join("\n")
    expect(refusalsIn(output)).toEqual([{ gate: "docs", rule: "point at the words, not the page" }])
  })

  test("drops the file locator and keeps the kit wording as the rule", () => {
    const refusal = refusalsIn(lintOutput)[0]
    expect(refusal.rule.startsWith("src/a.ts")).toBe(false)
    expect(refusal.rule).toBe(directiveRule)
  })

  test("records an identical refusal in one round only once", () => {
    const output = [
      "no-plain-js: 2 violation(s)",
      "  tools/plain.js: plain JavaScript source in a TypeScript repository; convert it to TypeScript",
      "  tools/other.js: plain JavaScript source in a TypeScript repository; convert it to TypeScript",
    ].join("\n")
    expect(refusalsIn(output)).toEqual([{
      gate: "no-plain-js",
      rule: "plain JavaScript source in a TypeScript repository; convert it to TypeScript",
    }])
  })

  test("records nothing for a pass and for errors outside the kit", () => {
    expect(refusalsIn("checks-lint: 2 gate(s) pass\ncomment-gate: 3 added line(s) across 1 file(s) carry no refused comment\n")).toEqual([])
    expect(refusalsIn("src/a.ts(1,2): error TS1234: this type is not assignable\n")).toEqual([])
    expect(refusalsIn("")).toEqual([])
  })

  test("reads the test skip verdict under the test gate", () => {
    const output = [
      "checks-test: 1 skipped test(s) undeclared in this local run:",
      "  tests/unit/foo.test.ts:10 my test: skipped with no reason at its test site; use test.skipIf(condition)(skipReason(reason, name), fn)",
    ].join("\n")
    expect(refusalsIn(output)).toEqual([{
      gate: "test",
      rule: "my test: skipped with no reason at its test site; use test.skipIf(condition)(skipReason(reason, name), fn)",
    }])
  })

  test("keeps copy problem sections instead of dropping non-violation headers", () => {
    const output = [
      "copy: 1 problem(s) in 2 file(s) from 1 declared input(s):",
      "  docs/a.md:3:5 point at the words, not the page",
    ].join("\n")
    expect(refusalsIn(output)).toEqual([{ gate: "copy", rule: "point at the words, not the page" }])
  })

  test("credits graphwalk sections to graphwalk instead of dropping them", () => {
    const output = [
      "checks-lint: 1 of 3 gate(s) failed: checks-graphwalk",
      "imports: 1 violation(s) in 12 file(s) from 3 entrypoint(s):",
      "  error no-cycle: src/a.ts -> src/b.ts",
      "unused: 1 unreferenced file(s):",
      "  src/unused.ts",
      "exports: 1 unused export(s) not in baseline:",
      "  src/c.ts: myFunc (export)",
    ].join("\n")
    expect(refusalsIn(output)).toEqual([
      { gate: "graphwalk", rule: "error no-cycle" },
      { gate: "graphwalk", rule: "unreferenced file" },
      { gate: "graphwalk", rule: "myFunc (export)" },
    ])
  })

  test("records secrets ranges that carry no digit after the colon instead of skipping them", () => {
    const output = [
      "checks-lint: 1 of 2 gate(s) failed: checks-secrets",
      "secrets: the range adds 1 secret(s); carry only allowed secrets:",
      "  src/foo.ts:10 SECRET123 in abcdef12: description here",
    ].join("\n")
    expect(refusalsIn(output)).toEqual([{ gate: "secrets", rule: "SECRET123: description here" }])
  })

  test("keeps commit-identity reasons instead of recording the sha and allowed lines", () => {
    const output = [
      "commit-identity: 1 of 2 commit(s) carry a foreign identity:",
      "  abc123def456 some subject",
      "    author Alice <a@x> differs from the allowed one",
      "    committer Bob <b@y> differs from the allowed one",
      "  allowed: Alice <a@x>",
      "  allowed as committer only: Bob <b@y>",
    ].join("\n")
    expect(refusalsIn(output)).toEqual([
      { gate: "commit-identity", rule: "author Alice <a@x> differs from the allowed one" },
      { gate: "commit-identity", rule: "committer Bob <b@y> differs from the allowed one" },
    ])
  })

  test("records single-line gate failures instead of missing them or keeping pass lines", () => {
    const output = [
      "effect-scope: the @effect/language-service entry in tsconfig.json differs from the generated one; run checks-effect-scope to rewrite them",
      "effect-scope: tsconfig.json holds the Effect paths from the template",
      "lint-coverage: oxlint skips 1/10 matched files in 1 command(s); missing:",
      "lint-coverage: 10/10 matched files in 1 command(s)",
      "src/a.ts:1:2: error TS1234: boom",
      "checks-lint: 1 of 2 gate(s) failed: checks-docs",
    ].join("\n")
    expect(refusalsIn(output)).toEqual([
      { gate: "effect-scope", rule: "the @effect/language-service entry in tsconfig.json differs from the generated one; run checks-effect-scope to rewrite them" },
      { gate: "lint-coverage", rule: "oxlint skips 1/10 matched files in 1 command(s); missing:" },
    ])
  })

  test("keeps repetition counts as distinct rules instead of grouping them", () => {
    const output = [
      "repetition: 2 file(s) hold repeat more lines than the baseline:",
      "  src/a.ts: 30 repeated line(s), up from 20",
      "    src/a.ts:1-5 repeats src/a.ts:10-14",
      "  src/a.ts: 40 repeated line(s), up from 20",
    ].join("\n")
    expect(refusalsIn(output)).toEqual([
      { gate: "repetition", rule: "30 repeated line(s), up from 20" },
      { gate: "repetition", rule: "40 repeated line(s), up from 20" },
    ])
  })

  test("ignores a gate section the kit summary never names", () => {
    const output = [
      "checks-lint: 1 of 2 gate(s) failed: checks-comment-gate",
      "comment-gate: 1 violation(s):",
      "  src/a.ts:1 carries the machine-read directive `x`. Fix it",
      "mystery: 2 violation(s):",
      "  src/b.ts:2 something odd",
    ].join("\n")
    expect(refusalsIn(output)).toEqual([{ gate: "comment-gate", rule: "carries the machine-read directive `x`. Fix it" }])
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
      expect(round.outcomes[0]?.refusals).toEqual([{ gate: "comment-gate", rule: directiveRule }])
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
  await recordRefusal(db, "run-1", 1, { gate: "comment-gate", rule: directiveRule })
  await recordRefusal(db, "run-1", 2, { gate: "comment-gate", rule: directiveRule })
  await recordRefusal(db, "run-2", 1, { gate: "comment-gate", rule: directiveRule })
  await recordRefusal(db, "run-2", 1, { gate: "docs", rule: "point at the words, not the page" })
}

describe("readRefusals", () => {
  test("counts one run once when two rounds hit the same refusal", async () => {
    const home = await mkdtemp(join(tmpdir(), "orc-refusals-db-"))
    try {
      const db = await openDb(home)
      try {
        await seedRuns(db)
        expect(await Effect.runPromise(readRefusals(db))).toEqual([
          { gate: "comment-gate", rule: directiveRule, runs: 2 },
          { gate: "docs", rule: "point at the words, not the page", runs: 1 },
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
    const counts = [{ gate: "comment-gate", rule: directiveRule, runs: 2 }]
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
    const table = formatRefusalsTable([{ gate: "comment-gate", rule: directiveRule, runs: 2 }])
    const head = table.split("\n")[0]
    expect(head.startsWith("GATE")).toBe(true)
    expect(head).toContain("RULE")
    expect(head.endsWith("RUNS")).toBe(true)
    expect(table).toContain("comment-gate")
    expect(table).toContain("2")
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
          refusals: [{ gate: "comment-gate", rule: directiveRule }]
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
          { gate: "comment-gate", rule: directiveRule, runs: 1 },
        ])
        const resumed = db.query(
          "SELECT COUNT(*) AS count FROM signals JOIN steps ON signals.step_id = steps.id WHERE steps.run_id = ? AND signals.name = ?"
        ).get("next-1", "refusal") as { readonly count: number }
        expect(resumed.count).toBe(0)
      } finally {
        db.close()
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
