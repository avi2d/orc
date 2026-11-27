import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanFinish, ghPrLink, git, readyToCheck, runOrcDeliveryStep, sandboxResult, sessionEnding, withHome, withRepo } from "./run-helpers"

const error = { id: "e", file: "work.txt", line: 1, severity: "error", action: "Fix the error.", description: "The result is wrong." }
const warning = { id: "w", file: "work.txt", line: 1, severity: "warning", action: "Fix the warning.", description: "The result is fragile." }
const info = { id: "i", file: "work.txt", line: null, severity: "info", action: "Name the helper.", description: "The helper name says nothing." }
const lateError = { id: "late", file: "other.txt", line: 3, severity: "error", action: "Close the file.", description: "The handle leaks." }

const exercise = async (reviews: ReadonlyArray<ReadonlyArray<typeof error>>) => {
  let result = { kinds: [] as Array<string>, evidence: [] as Array<string>, body: "", checks: 0, completed: false, prLink: null as string | null, prCreated: false }
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
        result = { kinds, evidence, body: await readFile(join(home, "runs", "step-run-1", "pr-body.md"), "utf8"), checks, completed: outcome.report.completed, prLink: outcome.report.prLink, prCreated: outcome.ghCalls.includes("pr create") }
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

test("warnings left after a fixed round 1 open a PR listing each with its reason rather than ending without a PR", async () => {
  const result = await exercise([[error, warning, info], [warning, info]])
  expect(result.kinds).toEqual(["implementer", "reviewer", "fixer", "reviewer"])
  expect(result.completed).toBe(true)
  expect(result.prCreated).toBe(true)
  expect(result.prLink).toBe(ghPrLink)
  expect(result.body).toContain(
    "Open review findings:\n" +
      "- warning `w` at `work.txt:1`: The result is fragile. Action: Fix the warning.\n" +
      "  - Left because its severity is below the round 2 bar, which fixes only errors.\n" +
      "- info `i` at `work.txt`: The helper name says nothing. Action: Name the helper.\n" +
      "  - Left because its severity is below the round 2 bar, which fixes only errors.\n"
  )
  expect(result.body).not.toContain("The result is wrong.")
  expect(result.body).toContain("The ask-user reason belongs to the later step that keeps ask-user findings from the fixer.")
})

test("an error left after round 2 names a repeat or the round limit rather than the severity bar", async () => {
  const result = await exercise([[error, warning], [error], [error, lateError]])
  expect(result.kinds).toEqual(["implementer", "reviewer", "fixer", "reviewer", "fixer", "reviewer"])
  expect(result.completed).toBe(true)
  expect(result.prCreated).toBe(true)
  expect(result.body).toContain(
    "- error `e` at `work.txt:1`: The result is wrong. Action: Fix the error.\n" +
      "  - Left because it has the same id and file as a finding the fixer received in round 2.\n" +
      "- error `late` at `other.txt:3`: The handle leaks. Action: Close the file.\n" +
      "  - Left because the round limit was reached: the review after fix round 2 reported it.\n"
  )
})
