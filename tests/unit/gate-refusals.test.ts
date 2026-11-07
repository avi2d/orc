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
      "  docs/a.md:4: names `foo.ts`, which is not in the repository",
      "  docs/a.md:4: names `foo.ts`, which is not in the repository",
      "checks-lint: 1 of 3 gate(s) failed: checks-docs",
    ].join("\n")
    expect(refusalsIn(output)).toEqual([{ gate: "docs", rule: "names `foo.ts`, which is not in the repository" }])
  })

  test("strips bracket, scope and spaced locators instead of keeping them in the rule", () => {
    const output = [
      "comment-gate: 3 violation(s):",
      "  src/pages/[slug].astro:1 carries the machine-read directive `x`. Fix it",
      "  packages/@scope/ui/src/x.ts:2 carries the machine-read directive `x`. Fix it",
      "  my docs/guide.md:3 carries the machine-read directive `x`. Fix it",
    ].join("\n")
    expect(refusalsIn(output)).toEqual([{ gate: "comment-gate", rule: "carries the machine-read directive `x`. Fix it" }])
  })

  test("groups css-size counts under the budget instead of splitting by lines", () => {
    const output = [
      "css-size: 2 violation(s)",
      "  src/a.css: 450 lines, over the 400-line budget; split the stylesheet into smaller files",
      "  src/b.css: 500 lines, over the 400-line budget; split the stylesheet into smaller files",
    ].join("\n")
    expect(refusalsIn(output)).toEqual([
      { gate: "css-size", rule: "over the 400-line budget; split the stylesheet into smaller files" },
    ])
  })

  test("groups long sentences under the cap instead of splitting by words", () => {
    const output = [
      "docs: 2 violation(s):",
      "  docs/a.md:12: carries a 41-word descriptive sentence, over the 25-word cap (procedural means an ordered list item, capped at 20 words)",
      "  docs/b.md:8: carries a 30-word descriptive sentence, over the 25-word cap (procedural means an ordered list item, capped at 20 words)",
    ].join("\n")
    expect(refusalsIn(output)).toEqual([
      { gate: "docs", rule: "over the 25-word cap (procedural means an ordered list item, capped at 20 words)" },
    ])
  })

  test("keeps different test names as different rules instead of grouping skips", () => {
    const output = [
      "checks-test: 2 skipped test(s) undeclared in this local run:",
      "  tests/unit/foo.test.ts:10 parses a: skipped with no reason at its test site; use test.skipIf(condition)(skipReason(reason, name), fn)",
      "  tests/unit/foo.test.ts:20 parses b: skipped with no reason at its test site; use test.skipIf(condition)(skipReason(reason, name), fn)",
    ].join("\n")
    expect(refusalsIn(output)).toEqual([
      {
        gate: "test",
        rule: "parses a: skipped with no reason at its test site; use test.skipIf(condition)(skipReason(reason, name), fn)",
      },
      {
        gate: "test",
        rule: "parses b: skipped with no reason at its test site; use test.skipIf(condition)(skipReason(reason, name), fn)",
      },
    ])
  })

  test("keeps browser nesting wording instead of merging into of the rendered page", () => {
    const output = [
      "browser: 2 failure(s) in 1 check run(s) over 1 route(s), 1 viewport(s), 1 state(s) and 1 target(s):",
      "  nesting at /about (en), desktop 1280x720, default: <p> is not permitted as content under <span> at 3:5 of the rendered page",
      "  nesting at /about (en), desktop 1280x720, default: <div> is not permitted as content under <button> at 7:2 of the rendered page",
    ].join("\n")
    expect(refusalsIn(output)).toEqual([
      {
        gate: "browser",
        rule: "nesting at /about (en), desktop 1280x720, default: <p> is not permitted as content under <span> at 3:5 of the rendered page",
      },
      {
        gate: "browser",
        rule: "nesting at /about (en), desktop 1280x720, default: <div> is not permitted as content under <button> at 7:2 of the rendered page",
      },
    ])
  })

  test("keeps the check and package names instead of stripping the first word", () => {
    const output = [
      "browser: 1 contrast check(s) axe cannot measure, reported as unverified:",
      "  contrast at /about (en), desktop 1280x720, default: color-contrast on .cta could not be measured",
      "advisories: 1 acknowledgement(s) in advisory-acks.json do not hold:",
      "  lodash GHSA-abcd-1234 expired on 2026-01-01; upgrade the package and delete the entry, or renew it with a later day",
    ].join("\n")
    expect(refusalsIn(output)).toEqual([
      {
        gate: "browser",
        rule: "contrast at /about (en), desktop 1280x720, default: color-contrast on .cta could not be measured",
      },
      {
        gate: "advisories",
        rule: "lodash GHSA-abcd-1234 expired on 2026-01-01; upgrade the package and delete the entry, or renew it with a later day",
      },
    ])
  })

  test("groups one workflow fault across lines instead of splitting by line number", () => {
    const output = [
      "ci-wiring: 2 bun setup step(s) drift from the fleet bun version:",
      "  .github/workflows/ci.yml line 12: job lint step 1 requests bun 1.1.0 from package.json, want 1.2.0",
      "  .github/workflows/ci.yml line 30: job lint step 1 requests bun 1.1.0 from package.json, want 1.2.0",
    ].join("\n")
    expect(refusalsIn(output)).toEqual([
      { gate: "ci-wiring", rule: "job lint step 1 requests bun 1.1.0 from package.json, want 1.2.0" },
    ])
  })

  test("groups README ceilings instead of splitting by largest section", () => {
    const output = [
      "docs: 2 violation(s):",
      "  README.md: is 6123 characters, over the 6,000-character ceiling for a README. Its largest section is Install at 2345 characters. Move that section to a page under docs/ and link it from the README in one line",
      "  README.md: is 7010 characters, over the 6,000-character ceiling for a README. Its largest section is Usage at 3102 characters. Move that section to a page under docs/ and link it from the README in one line",
    ].join("\n")
    expect(refusalsIn(output)).toEqual([
      {
        gate: "docs",
        rule: "over the 6,000-character ceiling for a README. Move that section to a page under docs/ and link it from the README in one line",
      },
    ])
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
      "  error no-cycle: src/a.ts \u2192 src/b.ts",
      "unused: 1 unreferenced file(s):",
      "  src/unused.ts",
      "exports: 1 unused export(s) not in exports-baseline.json:",
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
      "secrets: the range adds 1 secret(s); put a placeholder such as <private-key> in its place in the commit that added it, and rotate any secret that left this machine:",
      "  src/foo.ts:10 SECRET123 in abcdef12: description here",
    ].join("\n")
    expect(refusalsIn(output)).toEqual([{ gate: "secrets", rule: "SECRET123: description here" }])
  })

  test("ignores secrets notices and docs pass lines when only comment-gate failed", () => {
    const output = [
      "checks-lint: 1 of 9 gate(s) failed: checks-comment-gate",
      "comment-gate: 1 violation(s):",
      "  src/a.ts:1 carries the machine-read directive `x`. Fix it",
      "secrets: CHECKS_SECRETS_PACK is unset, so the kit's rules ran without a private pack",
      "secrets: the kit's rules and the private pack CHECKS_SECRETS_PACK names ran",
      "docs: no line the range adds or edits copies a version package.json or .bun-version pins",
      "docs: 2 doc file(s) the range touches hold to their templates",
      "lint-coverage: 10/10 tracked .ts/.tsx/.astro files",
      "effect-scope: tsconfig.json holds the Effect paths of oxlint.config.ts and the kit's severities",
    ].join("\n")
    expect(refusalsIn(output)).toEqual([{ gate: "comment-gate", rule: "carries the machine-read directive `x`. Fix it" }])
  })

  test("normalizes commit-identity reasons instead of recording names and emails", () => {
    const output = [
      "commit-identity: 1 of 2 commit(s) in base..head carry a foreign identity:",
      "  abc123def456 some subject",
      "    author Alice <a@x>",
      "    committer Bob <b@y>",
      "    trailer Co-authored-by: Bob <b@y>",
      "    trailer Co-authored-by: Mallory <m@x>",
      "  allowed: Alice <a@x>",
      "  allowed as committer only: GitHub <noreply@github.com>, which also lets an allowed email author under any name",
    ].join("\n")
    expect(refusalsIn(output)).toEqual([
      { gate: "commit-identity", rule: "author" },
      { gate: "commit-identity", rule: "committer" },
      { gate: "commit-identity", rule: "trailer Co-authored-by:" },
    ])
  })

  test("records single-line gate failures instead of missing them or keeping pass lines", () => {
    const output = [
      "checks-lint: 3 of 9 gate(s) failed: checks-effect-scope, checks-lint-coverage, checks-commit-identity",
      "effect-scope: the @effect/language-service entry in tsconfig.json differs from the Effect paths of oxlint.config.ts or the kit's severities; run checks-effect-scope to rewrite them",
      "effect-scope: tsconfig.json holds the Effect paths of oxlint.config.ts and the kit's severities",
      "lint-coverage: oxlint skips 1/10 tracked .ts/.tsx/.astro files; missing:",
      "lint-coverage: oxlint skips 3/10 tracked .ts/.tsx/.astro files; missing:",
      "src/missing-a.ts",
      "src/missing-b.ts",
      "lint-coverage: 10/10 tracked .ts/.tsx/.astro files",
      "lint-coverage: the program tsconfig.json builds holds the ts-reset rules is-array and json-parse",
      "commit-identity: package.json declares no author or contributors, so no identity is allowed; declare the owners there",
      "src/a.ts:2:1: error eslint(no-debugger): `debugger` statement is not allowed help: Remove the debugger statement",
    ].join("\n")
    expect(refusalsIn(output)).toEqual([
      { gate: "effect-scope", rule: "the @effect/language-service entry in tsconfig.json differs from the Effect paths of oxlint.config.ts or the kit's severities; run checks-effect-scope to rewrite them" },
      { gate: "lint-coverage", rule: "oxlint skips tracked .ts/.tsx/.astro files; missing:" },
      { gate: "commit-identity", rule: "package.json declares no author or contributors, so no identity is allowed; declare the owners there" },
    ])
  })

  test("drops the move target from test-layout rules instead of recording the path", () => {
    const output = [
      "test-layout: 1 violation(s)",
      "  tests/lib/foo.test.ts: tests/lib and tests/fixtures hold helpers and data, never tests; move it to tests/unit/foo.test.ts",
    ].join("\n")
    expect(refusalsIn(output)).toEqual([
      { gate: "test-layout", rule: "tests/lib and tests/fixtures hold helpers and data, never tests" },
    ])
  })

  test("groups repetition rises into one rule instead of splitting by counted lines", () => {
    const output = [
      "repetition: 2 file(s) .jscpd.json holds repeat more lines than where the range starts, at 50 tokens and 5 lines:",
      "  src/a.ts: 30 repeated line(s), up from 20",
      "    src/a.ts:1-5 repeats src/a.ts:10-14",
      "  src/a.ts: 40 repeated line(s), up from 20",
      "  src/b.ts: 5 repeated line(s)",
    ].join("\n")
    expect(refusalsIn(output)).toEqual([
      { gate: "repetition", rule: "repeated line(s), up from" },
      { gate: "repetition", rule: "repeated line(s)" },
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
