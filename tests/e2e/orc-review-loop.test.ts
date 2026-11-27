import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { openDatabase } from "../../packages/run/src/entities/run-history/index"
import { readShow, readStepLog } from "../../packages/run/src/features/seeing-runs/index"
import type { OrcRunReport } from "../../packages/run/src/features/running-a-task/run-record"
import { cleanFinish, ghPrLink, git, readyToCheck, recordedMetrics, runOrcDeliveryStep, sandboxResult, sessionEnding, withHome, withRepo } from "./run-helpers"

const error = { topic: "wrong-result", id: "e", file: "work.txt", line: 1, severity: "error", action: "Fix the error.", description: "The result is wrong." }
const warning = { topic: "fragile-result", id: "w", file: "work.txt", line: 1, severity: "warning", action: "Fix the warning.", description: "The result is fragile." }
const info = { topic: "helper-name", id: "i", file: "work.txt", line: null, severity: "info", action: "Name the helper.", description: "The helper name says nothing." }
const lateError = { topic: "handle-leak", id: "late", file: "other.txt", line: 3, severity: "error", action: "Close the file.", description: "The handle leaks." }

type Finding = Omit<typeof error, "line"> & { line: number | null }

const exercise = async (reviews: ReadonlyArray<ReadonlyArray<Finding>>, diagramReply = "no diagram", taskText = "Do the thing.\n", limit?: number, projectConfig?: string) => {
  let result = { report: undefined as OrcRunReport | undefined, kinds: [] as Array<string>, evidence: [] as Array<string>, body: "", checks: 0, completed: false, endReason: "", prLink: null as string | null, prCreated: false, steps: [] as unknown, metrics: [] as ReadonlyArray<unknown>, reviewEvidence: [] as ReadonlyArray<{ readonly file: string | undefined; readonly log: string }> }
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
        if (limit !== undefined) await writeFile(join(home, "config.json"), JSON.stringify({ providers: [], review: { maxFixRounds: limit } }))
        if (projectConfig !== undefined) await writeFile(join(dir, ".no-mistakes.yaml"), projectConfig)
        git(dir, ["checkout", "-q", "orc/test"])
        const kinds: Array<string> = []
        const evidence: Array<string> = []
        let review = 0
        let checks = 0
        const outcome = await runOrcDeliveryStep(dir, home, async (run, sessionsDir) => {
          kinds.push(run.agent.kind)
          if (run.agent.kind === "reviewer") {
            if (run.prompt.includes("no diagram")) {
              const taskFile = join(home, "runs", "step-run-1", "task.md")
              await writeFile(taskFile, taskText)
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
              return yield* Effect.forEach(document?.steps.filter((step) => step.name === "review" && step.status === "passed") ?? [], (step) =>
                readStepLog(db, "step-run-1", step.id).pipe(Effect.map((log) => {
                  const file = step.evidence.find((item) => item.direction === "out" && item.kind === "review")?.path
                  return { file: file === undefined ? undefined : basename(file), log }
                }))
              )
            }),
            (db) => Effect.sync(() => db.close())
          ).pipe(Effect.provide(BunServices.layer))
        )
        result = { report: outcome.report, kinds, evidence, reviewEvidence, body: outcome.report.prLink === null ? "" : await readFile(join(home, "runs", "step-run-1", "pr-body.md"), "utf8"), checks, completed: outcome.report.completed, endReason: outcome.report.endReason, steps: outcome.steps, prLink: outcome.report.prLink, prCreated: outcome.ghCalls.includes("pr create"), metrics: await recordedMetrics(home) }
      } finally {
        await rm(origin, { recursive: true, force: true })
      }
    })
  })
  return result
}

test("a malformed path rule fails the review without erasing implement or checks evidence", async () => {
  const result = await exercise([[]], "no diagram", undefined, undefined, 'commands:\n  lint: bun run lint\nreview:\n  path_instructions:\n    - path: "docs/**"\n')
  expect(result.report).toMatchObject({ implementPassed: true, markerVerified: true, completed: false, prLink: null })
  expect(result.report?.commits).toHaveLength(1)
  expect(result.report?.checksRounds).toHaveLength(1)
  expect(result.steps).toContainEqual({ name: "review", status: "failed" })
  expect(result.endReason).toContain("path_instructions")
  expect(result.prCreated).toBe(false)
  expect(result.kinds).toEqual(["implementer"])
}, 60_000)

test("an ask-user warning alone stops for a decision rather than a first-round severity bar", async () => {
  const result = await exercise([[{ ...warning, action: "ask-user" }]])
  expect(result.evidence).toHaveLength(0)
  expect(result.endReason).toContain("The review fix loop stopped because a finding needs the user's decision.")
  expect(result.body).toContain("Left because it asks the user.")
}, 60_000)

test("an ask-user warning after a fix stops for a decision rather than a severity bar", async () => {
  const result = await exercise([[error], [{ ...warning, action: "ask-user" }]])
  expect(result.evidence).toHaveLength(1)
  expect(result.endReason).toContain("The review fix loop stopped because a finding needs the user's decision.")
}, 60_000)

test("an empty review does not start a fixer", async () => {
  const result = await exercise([[]])
  expect(result.kinds).toEqual(["implementer", "reviewer", "reviewer"])
  expect(result.completed).toBe(true)
  expect(result.endReason).toContain("stopped because no error or warning remained.")
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
  expect(result.reviewEvidence.map(({ file, log }) => ({ file, findings: JSON.parse(log) }))).toEqual([
    { file: "review.json", findings: [error, warning] },
    { file: "review-2.json", findings: [lateError] },
    { file: "review-3.json", findings: [warning] }
  ])
}, 60_000)

test("warnings after the first fix do not count as a second gate stop", async () => {
  const result = await exercise([[error, warning], [warning]])
  expect(result.kinds).toEqual(["implementer", "reviewer", "fixer", "reviewer", "reviewer"])
  expect(result.completed).toBe(true)
  expect(result.metrics).toMatchObject([{ run: "step-run-1", delivery: "orc", failedSteps: 0, gateStops: 1, fixRounds: 1 }])
  expect(result.endReason).toContain("The review fix loop stopped because no finding met the later rounds' severity bar.")
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
      "  - Left because it has the same topic and file as a finding the fixer received in round 2.\n" +
      "- error `new` at `new.txt:1`: The result is wrong. Action: Fix the error.\n" +
      "  - Left because the review after fix round 2 reached the round limit.\n"
  )
}, 60_000)

test("a repeated topic with a new id and wording is not sent to the fixer again", async () => {
  const first = { ...error, topic: "result-error" }
  const repeated = { ...error, id: "new-id", topic: "result-error", description: "The calculation fails." }
  const result = await exercise([[first], [repeated, lateError]])
  expect(result.evidence).toHaveLength(1)
  expect(result.body).toContain("same topic and file")
  expect(result.body).toContain("Left because a finding repeated one sent to the fixer.")
  expect(result.endReason).toContain("stopped because a finding repeated one sent to the fixer.")
}, 60_000)

test("a reused id with different topics in the same file does not stop the second fixer round", async () => {
  const result = await exercise([[{ ...error, topic: "first" }], [{ ...error, topic: "second" }], []])
  expect(result.evidence).toHaveLength(2)
}, 60_000)

test("the default round limit does not start a third fix round", async () => {
  const result = await exercise([[error], [lateError], [{ ...error, id: "third", file: "third.txt" }]])
  expect(result.evidence).toHaveLength(2)
  expect(result.body).toContain("reached the round limit")
  expect(result.endReason).toContain("stopped because the configured fix round limit was reached.")
}, 60_000)

test("a limit of one does not start a second fix round", async () => {
  const result = await exercise([[error], [lateError]], "no diagram", undefined, 1)
  expect(result.evidence).toHaveLength(1)
  expect(result.body).toContain("review after fix round 1")
}, 60_000)

test("a configured limit above two does not stop a third fix round", async () => {
  const result = await exercise([[error], [lateError], [{ ...error, id: "third", file: "third.txt" }], []], "no diagram", undefined, 3)
  expect(result.evidence).toHaveLength(3)
}, 60_000)

test("a fixer receiving an ask-user finding or missing a fixable error", async () => {
  const askedError = { ...error, action: "ask-user" }
  const askedWarning = { ...warning, action: "ask-user" }
  const result = await exercise([[askedError, askedWarning, lateError], []])
  expect(result.evidence.map((value) => JSON.parse(value))).toEqual([[lateError]])
  expect(result.completed).toBe(true)
}, 60_000)

test("the PR body does not omit findings that need a person from any review round", async () => {
  const askedError = { ...error, action: "ask-user" }
  const askedWarning = { ...warning, action: "ask-user" }
  const result = await exercise([[askedError, lateError], [askedWarning]])
  expect(result.completed).toBe(true)
  expect(result.body).toContain("## Findings that need a person")
  expect(result.body).toContain("The result is wrong.")
  expect(result.body).toContain("The result is fragile.")
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
  expect(result.endReason).toContain("stopped because no error or warning remained.")
  expect(result.body).toContain("Left because it asks the user.")
}, 60_000)

test("a repeated warning below the second round bar does not block a new error", async () => {
  const result = await exercise([[error, warning], [lateError, warning], []])
  expect(result.evidence.map((value) => JSON.parse(value))).toEqual([[error, warning], [lateError]])
  expect(result.endReason).toContain("stopped because no error or warning remained.")
}, 60_000)

test("a warning never sent in round 2 does not block a new error in round 3", async () => {
  const third = { ...error, id: "third", file: "third.txt" }
  const result = await exercise([[error], [lateError, warning], [third, warning], []], "no diagram", undefined, 3)
  expect(result.evidence.map((value) => JSON.parse(value))).toEqual([[error], [lateError], [third]])
}, 60_000)

test("an info-only review does not claim a second round severity bar", async () => {
  const result = await exercise([[info]])
  expect(result.evidence).toHaveLength(0)
  expect(result.endReason).toContain("stopped because no error or warning remained.")
  expect(result.body).toContain("Left because no error or warning remained.")
  expect(result.body).not.toContain("round 2 bar")
}, 60_000)

test("a limit of one does not label a remaining warning as below the round 2 bar", async () => {
  const result = await exercise([[error], [warning]], "no diagram", undefined, 1)
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
  const result = await exercise([[error, asked], [current]], "no diagram", undefined, 1)
  expect(result.body).toContain("error `updated`")
  expect(result.body).toContain("The result corrupts saved data.")
  expect(result.body).not.toContain("The result is fragile.")
  expect(result.body).not.toContain("Left because it asks the user.")
}, 60_000)

test("a drawn diagram lands as a mermaid fence rather than prose", async () => {
  const result = await exercise([[]], "Why: The change connects the two steps.\n```mermaid\nflowchart LR\n  task --> run\n```")
  expect(result.completed).toBe(true)
  expect(result.prCreated).toBe(true)
  expect(result.body).toContain("## How it fits\n\n```mermaid\nflowchart LR\n  task --> run\n```")
  expect(result.body).not.toContain("Do the thing.")
  expect(result.body).toContain("## Why\n\nThe change connects the two steps.\n\n## What changed")
}, 60_000)

test("a declined diagram leaves How it fits out rather than an empty section", async () => {
  const result = await exercise([[]])
  expect(result.completed).toBe(true)
  expect(result.body).not.toContain("## How it fits")
  expect(result.body).not.toContain("Do the thing.")
  expect(result.body).toContain("## Why\n\nNo reason was recorded for this change; see What changed.\n\n## What changed")
}, 60_000)

for (const reply of [
  "**Why:** Cached reads avoid repeated disk access.\nno diagram",
  "**Why**: Cached reads avoid repeated disk access.\nno diagram",
  "Why:\nCached reads avoid repeated disk access.\nno diagram",
  "**Why:**\n\nCached reads avoid repeated disk access.\r\nno diagram"
]) {
  test("a formatted reason is not lost or prefixed with the title: " + JSON.stringify(reply), async () => {
    const result = await exercise([[]], reply)
    expect(result.completed).toBe(true)
    expect(result.body).toContain("## Why\n\nCached reads avoid repeated disk access.\n\n## What changed")
  }, 60_000)
}

const privateTask = "Keep this internal. The violet otter carries seven sealed crates across the quiet harbor before sunrise.\nDo the thing.\n"

for (const reason of [
  "This matters because the violet otter carries seven sealed crates across the quiet harbor before sunrise.",
  "Avoid this because VIOLET, otter carries seven sealed crates across the quiet harbor."
]) {
  test("eight copied task words cannot enter Why: " + reason, async () => {
    const result = await exercise([[]], "Why: " + reason + "\nno diagram", privateTask)
    expect(result.completed).toBe(true)
    expect(result.body).toContain("## Why\n\nNo reason was recorded for this change; see What changed.\n\n## What changed")
    expect(result.body).not.toContain(reason)
  }, 60_000)
}

test("copied task text in a diagram cannot bypass the public body comparison", async () => {
  const result = await exercise([[]], "Why: Cached reads avoid repeated disk access.\n```mermaid\nflowchart LR\n  a[the violet otter carries seven sealed crates across the quiet harbor before sunrise] --> b[Cache]\n```", privateTask)
  expect(result.completed).toBe(true)
  expect(result.body).toContain("## Why\n\nCached reads avoid repeated disk access.\n\n## What changed")
  expect(result.body).not.toContain("the violet otter carries seven sealed crates")
  expect(result.body).not.toContain("## How it fits")
}, 60_000)

test("a short shared task label does not discard the reason or diagram", async () => {
  const result = await exercise([[]], "Why: This fixes a problem with repeated reads.\n```mermaid\nflowchart LR\n  read --> review\n```", "## Problem\n## Review\n")
  expect(result.body).toContain("This fixes a problem with repeated reads.")
  expect(result.body).toContain("flowchart LR\n  read --> review")
}, 60_000)

for (const reply of ["Why:\nno diagram", "Why:\n```mermaid\nflowchart LR\n  a --> b\n```"]) {
  test("an empty Why cannot turn diagram output into a reason: " + JSON.stringify(reply), async () => {
    const result = await exercise([[]], reply)
    expect(result.completed).toBe(true)
    expect(result.body).toContain("## Why\n\nNo reason was recorded for this change; see What changed.\n\n## What changed")
  }, 60_000)
}
