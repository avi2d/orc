import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanFinish, git, readyToCheck, recordedMetrics, runOrcDeliveryStep, sandboxResult, sessionEnding, withHome, withRepo } from "./run-helpers"

const error = { id: "e", file: "work.txt", line: 1, severity: "error", action: "Fix the error.", description: "The result is wrong." }
const warning = { id: "w", file: "work.txt", line: 1, severity: "warning", action: "Fix the warning.", description: "The result is fragile." }

const exercise = async (reviews: ReadonlyArray<ReadonlyArray<typeof error>>) => {
  let result = { kinds: [] as Array<string>, evidence: [] as Array<string>, body: "", checks: 0, completed: false, steps: [] as unknown, metrics: [] as ReadonlyArray<unknown> }
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
        result = { kinds, evidence, body: await readFile(join(home, "runs", "step-run-1", "pr-body.md"), "utf8"), checks, completed: outcome.report.completed, steps: outcome.steps, metrics: await recordedMetrics(home) }
      } finally {
        await rm(origin, { recursive: true, force: true })
      }
    })
  })
  return result
}

test("an empty review does not start a fixer", async () => {
  const result = await exercise([[]])
  expect(result.kinds).toEqual(["implementer", "reviewer"])
  expect(result.completed).toBe(true)
})

test("a cleared first fix does not start a second round", async () => {
  const result = await exercise([[error, warning], []])
  expect(result.kinds).toEqual(["implementer", "reviewer", "fixer", "reviewer"])
  expect(result.evidence[0]).toContain('"id": "e"')
  expect(result.evidence[0]).toContain('"id": "w"')
  expect(result.checks).toBe(2)
})

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

test("the second fix receives only errors and a third fix never starts", async () => {
  const result = await exercise([[error, warning], [error, warning], [error, warning]])
  expect(result.kinds).toEqual(["implementer", "reviewer", "fixer", "reviewer", "fixer", "reviewer"])
  expect(result.evidence[1]).toContain('"id": "e"')
  expect(result.evidence[1]).not.toContain('"id": "w"')
  expect(result.checks).toBe(3)
  expect(result.completed).toBe(true)
  expect(result.body).toContain("The result is wrong.")
  expect(result.body).toContain("The result is fragile.")
})
