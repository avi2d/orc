import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { openDatabase } from "../../packages/run/src/entities/run-history/index"
import { readShow, readStepLog } from "../../packages/run/src/features/seeing-runs/index"
import { cleanFinish, ghPrLink, git, readyToCheck, recordedMetrics, runOrcDeliveryStep, sandboxResult, sessionEnding, withHome, withRepo } from "./run-helpers"

const error = { id: "e", file: "work.txt", line: 1, severity: "error", action: "Fix the error.", description: "The result is wrong." }
const warning = { id: "w", file: "work.txt", line: 1, severity: "warning", action: "Fix the warning.", description: "The result is fragile." }
const info = { id: "i", file: "work.txt", line: null, severity: "info", action: "Name the helper.", description: "The helper name says nothing." }
const lateError = { id: "late", file: "other.txt", line: 3, severity: "error", action: "Close the file.", description: "The handle leaks." }

type Finding = Omit<typeof error, "line"> & { line: number | null }

const exercise = async (reviews: ReadonlyArray<ReadonlyArray<Finding>>, diagramReply = "no diagram") => {
  let result = { kinds: [] as Array<string>, evidence: [] as Array<string>, body: "", checks: 0, completed: false, prLink: null as string | null, prCreated: false, steps: [] as unknown, metrics: [] as ReadonlyArray<unknown>, reviewEvidence: [] as ReadonlyArray<{ readonly file: string | undefined; readonly log: string }> }
  await withRepo(async (dir) => {
    await withHome(async (home) => {
      const origin = await mkdtemp(join(tmpdir(), "orc-loop-origin-"))
      try {
        git(origin, ["init", "-q", "--bare"])
        git(dir, ["remote", "add", "origin", origin])
        const base = git(dir, ["branch", "--show-current"])
        git(dir, ["push", "-u", "origin", base])
        git(dir, ["remote", "set-head", "origin", base])
        const sha = await readyToCheck(dir, home)
        git(dir, ["checkout", "-q", "orc/test"])
        const kinds: Array<string> = []
        const evidence: Array<string> = []
        let review = 0
        let checks = 0
        const outcome = await runOrcDeliveryStep(dir, home, async (run, sessionsDir) => {
          kinds.push(run.agent.kind)
          if (run.agent.kind === "reviewer") {
            if (run.prompt.includes("no diagram")) {
              const sessionFile = join(sessionsDir, "diagram.jsonl")
              await writeFile(sessionFile, sessionEnding({ role: "assistant", content: [{ type: "text", text: diagramReply }], stopReason: "stop", usage: { input: 1, output: 1 } }))
              return { sessionFile, commits: [] }
            }
            const sessionFile = join(sessionsDir, "review-script-" + review.toString() + ".jsonl")
            await writeFile(sessionFile, sessionEnding({ role: "assistant", content: [{ type: "text", text: JSON.stringify(reviews[review++] ?? []) }], stopReason: "stop", usage: { input: 1, output: 1 } }))
            return { sessionFile, commits: [] }
          }
          if (run.agent.kind === "fixer") {
            const path = /(?:in|at) ([^\n]+)\./.exec(run.prompt)?.[1]
            if (path !== undefined) evidence.push(await readFile(path, "utf8"))
            await writeFile(join(dir, "fix-" + evidence.length.toString()), "fixed\n")
            git(dir, ["add", "."])
            git(dir, ["commit", "-qm", "fix review"])
            const sessionFile = join(sessionsDir, "fix-script-" + evidence.length.toString() + ".jsonl")
            await writeFile(sessionFile, sessionEnding(cleanFinish))
            return { sessionFile, commits: [{ sha: git(dir, ["rev-parse", "HEAD"]) }] }
          }
          return sandboxResult(sha)(run, sessionsDir)
        }, async () => {
          checks += 1
          return { stdout: "ok", stderr: "", exitCode: 0 }
        })
        const reviewEvidence = await Effect.runPromise(
          Effect.acquireUseRelease(
            openDatabase(home),
            (db) => Effect.gen(function*() {
              const document = yield* readShow(db, "step-run-1")
              return yield* Effect.forEach(document?.steps.filter((step) => step.name === "review") ?? [], (step) =>
                readStepLog(db, "step-run-1", step.id).pipe(Effect.map((log) => {
                  const file = step.evidence.find((item) => item.direction === "out" && item.kind === "review")?.path
                  return { file: file === undefined ? undefined : basename(file), log }
                }))
              )
            }),
            (db) => Effect.sync(() => db.close())
          ).pipe(Effect.provide(BunServices.layer))
        )
        result = { kinds, evidence, reviewEvidence, body: await readFile(join(home, "runs", "step-run-1", "pr-body.md"), "utf8"), checks, completed: outcome.report.completed, steps: outcome.steps, prLink: outcome.report.prLink, prCreated: outcome.ghCalls.includes("pr create"), metrics: await recordedMetrics(home) }
      } finally {
        await rm(origin, { recursive: true, force: true })
      }
    })
  })
  return result
}

test("an empty review does not start a fixer", async () => {
  const result = await exercise([[]])
  expect(result.kinds).toEqual(["implementer", "reviewer", "reviewer"])
  expect(result.completed).toBe(true)
}, 60_000)

test("a cleared first fix does not start a second round", async () => {
  const result = await exercise([[error, warning], []])
  expect(result.kinds).toEqual(["implementer", "reviewer", "fixer", "reviewer", "reviewer"])
  expect(result.evidence[0]).toContain('"id": "e"')
  expect(result.evidence[0]).toContain('"id": "w"')
  expect(result.checks).toBe(2)
}, 60_000)

test("a review whose findings one fix round clears counts one gate stop rather than none, and records both review turns", async () => {
  const result = await exercise([[error, warning], []])
  expect(result.steps).toEqual([
    { name: "implement", status: "passed" },
    { name: "checks", status: "passed" },
    { name: "review", status: "passed" },
    { name: "fix", status: "passed" },
    { name: "checks", status: "passed" },
    { name: "review", status: "passed" },
    { name: "pr", status: "passed" }
  ])
  expect(result.metrics).toMatchObject([{ run: "step-run-1", delivery: "orc", failedSteps: 0, gateStops: 1, fixRounds: 1 }])
})

test("the second fix receives only errors and a third review adds neither a fix nor a gate stop", async () => {
  const result = await exercise([[error, warning], [error, warning], [error, warning]])
  expect(result.kinds).toEqual(["implementer", "reviewer", "fixer", "reviewer", "fixer", "reviewer", "reviewer"])
  expect(result.evidence[1]).toContain('"id": "e"')
  expect(result.evidence[1]).not.toContain('"id": "w"')
  expect(result.checks).toBe(3)
  expect(result.metrics).toMatchObject([{ run: "step-run-1", delivery: "orc", failedSteps: 0, gateStops: 2, fixRounds: 2 }])
  expect(result.completed).toBe(true)
  expect(result.body).toContain("The result is wrong.")
  expect(result.body).toContain("The result is fragile.")
}, 60_000)

test("each review step log keeps its own findings instead of the final turn's findings", async () => {
  const result = await exercise([[error, warning], [error], [warning]])
  expect(result.reviewEvidence).toEqual([
    { file: "review.json", log: JSON.stringify([error, warning], null, 2) + "\n" },
    { file: "review-2.json", log: JSON.stringify([error], null, 2) + "\n" },
    { file: "review-3.json", log: JSON.stringify([warning], null, 2) + "\n" }
  ])
}, 60_000)

test("warnings after the first fix do not count as a second gate stop", async () => {
  const result = await exercise([[error, warning], [warning]])
  expect(result.kinds).toEqual(["implementer", "reviewer", "fixer", "reviewer", "reviewer"])
  expect(result.completed).toBe(true)
  expect(result.metrics).toMatchObject([{ run: "step-run-1", delivery: "orc", failedSteps: 0, gateStops: 1, fixRounds: 1 }])
}, 60_000)

test("warnings left after a fixed round 1 open a PR listing each with its reason rather than ending without a PR", async () => {
  const result = await exercise([[error, warning, info], [warning, info]])
  expect(result.kinds).toEqual(["implementer", "reviewer", "fixer", "reviewer", "reviewer"])
  expect(result.completed).toBe(true)
  expect(result.prCreated).toBe(true)
  expect(result.prLink).toBe(ghPrLink)
  expect(result.body).toContain(
    "## Open review findings\n\n" +
      "- warning `w` at `work.txt:1`: The result is fragile. Action: Fix the warning.\n" +
      "  - Left because its severity is below the round 2 bar, which fixes only errors.\n" +
      "- info `i` at `work.txt`: The helper name says nothing. Action: Name the helper.\n" +
      "  - Left because its severity is below the round 2 bar, which fixes only errors.\n"
  )
  expect(result.body).not.toContain("The result is wrong.")
}, 60_000)

test("an error left after round 2 names a repeat or the round limit rather than the severity bar", async () => {
  const result = await exercise([[error, warning], [error], [error, lateError]])
  expect(result.kinds).toEqual(["implementer", "reviewer", "fixer", "reviewer", "fixer", "reviewer", "reviewer"])
  expect(result.completed).toBe(true)
  expect(result.prCreated).toBe(true)
  expect(result.body).toContain(
    "## Open review findings\n\n" +
    "- error `e` at `work.txt:1`: The result is wrong. Action: Fix the error.\n" +
      "  - Left because it has the same id and file as a finding the fixer received in round 2.\n" +
      "- error `late` at `other.txt:3`: The handle leaks. Action: Close the file.\n" +
      "  - Left because the round limit was reached: the review after fix round 2 reported it.\n"
  )
}, 60_000)

test("a drawn diagram lands as a mermaid fence rather than prose", async () => {
  const result = await exercise([[]], "```mermaid\nflowchart LR\n  task --> run\n```")
  expect(result.completed).toBe(true)
  expect(result.prCreated).toBe(true)
  expect(result.body).toContain("## How it fits\n\n```mermaid\nflowchart LR\n  task --> run\n```")
  expect(result.body).toContain("## Why\n\nDo the thing.")
}, 60_000)

test("a declined diagram leaves How it fits out rather than an empty section", async () => {
  const result = await exercise([[]])
  expect(result.completed).toBe(true)
  expect(result.body).not.toContain("## How it fits")
  expect(result.body).toContain("## Why\n\nDo the thing.")
}, 60_000)
