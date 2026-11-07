import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Database } from "bun:sqlite"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path } from "effect"
import { openDatabase, recordRun, recordSignal, recordStep } from "../../packages/run/src/run-history"
import { runChecksRound, type CommandResult } from "../../packages/run/src/checks"
import {
  decodeRefusalsJson,
  REFUSALS_JSON_SCHEMA,
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
    expect(refusalsJson(counts)).toEqual({ schema: REFUSALS_JSON_SCHEMA, refusals: counts })
    const decoded = await Effect.runPromise(encodeRefusalsJson(counts).pipe(Effect.flatMap((text) => decodeRefusalsJson(JSON.parse(text)))))
    expect(decoded.schema).toBe(REFUSALS_JSON_SCHEMA)
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
