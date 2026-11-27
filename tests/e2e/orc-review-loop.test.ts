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

type Finding = Omit<typeof error, "line"> & { line: number | null; topic?: string }

const exercise = async (reviews: ReadonlyArray<ReadonlyArray<Finding>>, diagramReply = "no diagram", limit?: number) => {
  let result = { kinds: [] as Array<string>, evidence: [] as Array<string>, body: "", checks: 0, completed: false, endReason: "", prLink: null as string | null, prCreated: false, steps: [] as unknown, metrics: [] as ReadonlyArray<unknown>, reviewEvidence: [] as ReadonlyArray<{ readonly file: string | undefined; readonly log: string }> }
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
        if (limit !== undefined) await writeFile(join(dir, ".no-mistakes.yaml"), "commands:\n  lint: bun run lint\nreview:\n  max_fix_rounds: " + limit.toString() + "\n")
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
        result = { kinds, evidence, reviewEvidence, body: await readFile(join(home, "runs", "step-run-1", "pr-body.md"), "utf8"), checks, completed: outcome.report.completed, endReason: outcome.report.endReason, steps: outcome.steps, prLink: outcome.report.prLink, prCreated: outcome.ghCalls.includes("pr create"), metrics: await recordedMetrics(home) }
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
  expect(result.endReason).toContain("stopped: cleared")
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
  const result = await exercise([[error], [lateError, warning], [error, warning]])
  expect(result.kinds).toEqual(["implementer", "reviewer", "fixer", "reviewer", "fixer", "reviewer", "reviewer"])
  expect(result.evidence[1]).toContain('"id": "late"')
  expect(result.evidence[1]).not.toContain('"id": "w"')
  expect(result.checks).toBe(3)
  expect(result.metrics).toMatchObject([{ run: "step-run-1", delivery: "orc", failedSteps: 0, gateStops: 2, fixRounds: 2 }])
  expect(result.completed).toBe(true)
  expect(result.body).toContain("The result is wrong.")
  expect(result.body).toContain("The result is fragile.")
}, 60_000)

test("each review step log keeps its own findings instead of the final turn's findings", async () => {
  const result = await exercise([[error, warning], [lateError], [warning]])
  expect(result.reviewEvidence).toEqual([
    { file: "review.json", log: JSON.stringify([error, warning], null, 2) + "\n" },
    { file: "review-2.json", log: JSON.stringify([lateError], null, 2) + "\n" },
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
  const result = await exercise([[error, warning], [lateError], [lateError, { ...error, id: "new", file: "new.txt" }]])
  expect(result.kinds).toEqual(["implementer", "reviewer", "fixer", "reviewer", "fixer", "reviewer", "reviewer"])
  expect(result.completed).toBe(true)
  expect(result.prCreated).toBe(true)
  expect(result.body).toContain(
    "## Open review findings\n\n" +
    "- error `late` at `other.txt:3`: The handle leaks. Action: Close the file.\n" +
      "  - Left because it has the same id and file as a finding the fixer received in round 2.\n" +
      "- error `new` at `new.txt:1`: The result is wrong. Action: Fix the error.\n" +
      "  - Left because the round limit was reached: the review after fix round 2 reported it.\n"
  )
}, 60_000)

test("a repeated topic with a new id and wording is not sent to the fixer again", async () => {
  const first = { ...error, topic: "result-error" }
  const repeated = { ...error, id: "new-id", topic: "result-error", description: "The calculation fails." }
  const result = await exercise([[first], [repeated]])
  expect(result.evidence).toHaveLength(1)
  expect(result.body).toContain("same topic and file")
  expect(result.endReason).toContain("stopped: repeat")
}, 60_000)

test("different topics in the same file do not stop the second fixer round", async () => {
  const result = await exercise([[{ ...error, topic: "first" }], [{ ...error, id: "second", topic: "second" }], []])
  expect(result.evidence).toHaveLength(2)
}, 60_000)

test("the default round limit does not start a third fix round", async () => {
  const result = await exercise([[error], [lateError], [{ ...error, id: "third", file: "third.txt" }]])
  expect(result.evidence).toHaveLength(2)
  expect(result.body).toContain("round limit was reached")
  expect(result.endReason).toContain("stopped: round-limit")
}, 60_000)

test("a limit of one does not start a second fix round", async () => {
  const result = await exercise([[error], [lateError]], "no diagram", 1)
  expect(result.evidence).toHaveLength(1)
  expect(result.body).toContain("review after fix round 1")
}, 60_000)

test("a configured limit above two does not stop a third fix round", async () => {
  const result = await exercise([[error], [lateError], [{ ...error, id: "third", file: "third.txt" }], []], "no diagram", 3)
  expect(result.evidence).toHaveLength(3)
}, 60_000)

test("a repeated id without a topic is not sent to the fixer again", async () => {
  const result = await exercise([[error], [{ ...error, description: "A different description." }]])
  expect(result.evidence).toHaveLength(1)
  expect(result.body).toContain("same id and file")
}, 60_000)

test("an ask-user error is not sent to the fixer and remains in the PR", async () => {
  const result = await exercise([[{ ...error, action: "ask-user" }, lateError]])
  expect(result.evidence).toHaveLength(0)
  expect(result.body).toContain("Left because it asks the user.")
  expect(result.body).toContain("The handle leaks.")
  expect(result.endReason).toContain("stopped: ask-user")
}, 60_000)

test("an ask-user warning is not sent to the fixer", async () => {
  const result = await exercise([[error, { ...warning, action: "ask-user" }], []])
  expect(result.evidence).toHaveLength(1)
  expect(result.evidence[0]).not.toContain('"id": "w"')
  expect(result.body).toContain("Left because it asks the user.")
}, 60_000)

test("round 1 does not drop info findings or send ask-user info to the fixer", async () => {
  const asked = { ...info, id: "decision", action: "ask-user" }
  const result = await exercise([[error, info, asked], []])
  expect(result.evidence.map((value) => JSON.parse(value))).toEqual([[error, info]])
  expect(result.body).toContain("info `decision`")
  expect(result.body).toContain("Left because it asks the user.")
}, 60_000)

test("a re-reported ask-user warning does not block a new error from the second fixer", async () => {
  const asked = { ...warning, action: "ask-user" }
  const result = await exercise([[error, asked], [lateError, asked], []])
  expect(result.evidence.map((value) => JSON.parse(value))).toEqual([[error], [lateError]])
  expect(result.endReason).toContain("stopped: cleared")
  expect(result.body).toContain("Left because it asks the user.")
}, 60_000)

test("a repeated warning below the second round bar does not block a new error", async () => {
  const result = await exercise([[error, warning], [lateError, warning], []])
  expect(result.evidence.map((value) => JSON.parse(value))).toEqual([[error, warning], [lateError]])
  expect(result.endReason).toContain("stopped: cleared")
}, 60_000)

test("a warning never sent in round 2 does not block a new error in round 3", async () => {
  const third = { ...error, id: "third", file: "third.txt" }
  const result = await exercise([[error], [lateError, warning], [third, warning], []], "no diagram", 3)
  expect(result.evidence.map((value) => JSON.parse(value))).toEqual([[error], [lateError], [third]])
}, 60_000)

test("an info-only review does not claim a second round severity bar", async () => {
  const result = await exercise([[info]])
  expect(result.evidence).toHaveLength(0)
  expect(result.endReason).toContain("stopped: cleared")
  expect(result.body).toContain("Left because the review fix loop stopped: cleared.")
  expect(result.body).not.toContain("round 2 bar")
}, 60_000)

test("a limit of one does not label a remaining warning as below the round 2 bar", async () => {
  const result = await exercise([[error], [warning]], "no diagram", 1)
  expect(result.evidence).toHaveLength(1)
  expect(result.body).toContain("review after fix round 1")
  expect(result.body).not.toContain("round 2 bar")
}, 60_000)

test("a retained ask-user finding does not inflate the recorded final review count", async () => {
  const result = await exercise([[error, { ...warning, action: "ask-user" }], []])
  expect(result.reviewEvidence.at(-1)).toMatchObject({ file: "review-2.json", log: "[]\n" })
  expect(result.endReason).toContain("The review turn recorded 0 findings in ")
  expect(result.body).toContain("warning `w`")
}, 60_000)

test("a retained ask-user finding does not overwrite the final review's newer wording or action", async () => {
  const asked = { ...warning, topic: "result-fragile", action: "ask-user" }
  const current = { ...error, id: "updated", topic: "result-fragile", description: "The result corrupts saved data." }
  const result = await exercise([[error, asked], [current]], "no diagram", 1)
  expect(result.body).toContain("error `updated`")
  expect(result.body).toContain("The result corrupts saved data.")
  expect(result.body).not.toContain("The result is fragile.")
  expect(result.body).not.toContain("Left because it asks the user.")
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
