import { describe, expect, test } from "bun:test"
import { Effect, Result } from "effect"
import { join } from "node:path"
import { ciVerdictLine, ciVerdictOf, readCiVerdict, type CiVerdict } from "../../packages/run/src/entities/pull-request/index"

const head = "6dcb09b5b57875f334f61aebed695e2e4193db5e"
const fixtures = join(import.meta.dir, "..", "fixtures", "github", "check-runs")
const payload = (name: string): Promise<string> => Bun.file(join(fixtures, name + ".json")).text()

const verdictOf = async (name: string, sha: string = head): Promise<CiVerdict> => {
  const verdict = ciVerdictOf(await payload(name), sha)
  if (Result.isFailure(verdict)) {
    throw new Error(verdict.failure)
  }
  return verdict.success
}

describe("the CI verdict read from GitHub check runs", () => {
  test("all green check runs on the head pass", async () => {
    const verdict = await verdictOf("all-green")
    expect(verdict).toEqual({ kind: "passed", headSha: head, checks: ["test", "lint", "docs"] })
    expect(ciVerdictLine(verdict)).toBe("CI verdict for 6dcb09b5b578: passed, test, lint, docs green.")
  })

  test("one failed check run fails with its name", async () => {
    const verdict = await verdictOf("one-failed")
    expect(verdict).toEqual({ kind: "failed", headSha: head, failing: ["test"] })
    expect(ciVerdictLine(verdict)).toBe("CI verdict for 6dcb09b5b578: failed, the check test failed.")
  })

  test("one queued check run leaves the verdict pending instead of passing", async () => {
    const verdict = await verdictOf("one-queued")
    expect(verdict.kind).toBe("pending")
    expect(verdict.kind === "pending" ? verdict.waiting : null).toEqual(["test"])
    expect(ciVerdictLine(verdict)).toBe("CI verdict for 6dcb09b5b578: pending, waiting on CI because the check test has not finished.")
  })

  test("a stale head's green check runs do not pass the current head", async () => {
    const verdict = await verdictOf("other-head")
    expect(verdict.kind).toBe("pending")
    expect(ciVerdictLine(verdict)).toBe("CI verdict for 6dcb09b5b578: pending, waiting on CI because no check run has reported on " + head + " yet, and 2 check runs belong to another head.")
  })

  test("green check runs read against another head sha do not pass", async () => {
    const verdict = await verdictOf("all-green", "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d")
    expect(verdict.kind).toBe("pending")
  })

  test("an independent same-name success does not hide a same-name failure", () => {
    const runs = JSON.stringify({ total_count: 2, check_runs: [
      { id: 7, name: "test", head_sha: head, status: "completed", conclusion: "failure", check_suite: { id: 11 }, app: { id: 1, slug: "ci-one" } },
      { id: 9, name: "test", head_sha: head, status: "completed", conclusion: "success", check_suite: { id: 12 }, app: { id: 2, slug: "ci-two" } }
    ] })
    expect(ciVerdictOf(runs, head)).toEqual(Result.succeed({ kind: "failed", headSha: head, failing: ["test"] }))
  })

  test("a payload that is no check-run list is refused", () => {
    expect(Result.isFailure(ciVerdictOf("{\"message\":\"Not Found\"}", head))).toBe(true)
  })

  test("reads the check runs of the PR's repository at the head sha through gh api", async () => {
    const asked: Array<string> = []
    const body = await payload("all-green")
    const verdict = await Effect.runPromise(readCiVerdict((hostname, apiPath) => {
      asked.push(hostname + " " + apiPath)
      return Effect.succeed({ stdout: body, stderr: "", exitCode: 0 })
    }, "https://github.com/o/r/pull/9", head))
    expect(asked).toEqual(["github.com repos/o/r/commits/" + head + "/check-runs?per_page=100"])
    expect(verdict.kind).toBe("passed")
  })

  test("a gh api failure leaves the verdict pending instead of passing", async () => {
    const verdict = await Effect.runPromise(readCiVerdict(() => Effect.succeed({ stdout: "", stderr: "HTTP 404", exitCode: 1 }), "https://github.com/o/r/pull/9", head))
    expect(verdict.kind).toBe("pending")
    expect(ciVerdictLine(verdict)).toContain("orc could not read the check runs: gh api exited 1: HTTP 404")
  })

  test("a partial check-run list stays pending instead of passing on the runs seen", () => {
    const runs = JSON.stringify({ total_count: 2, check_runs: [
      { id: 1, name: "lint", head_sha: head, status: "completed", conclusion: "success" }
    ] })
    expect(ciVerdictOf(runs, head)).toEqual(Result.succeed({ kind: "pending", headSha: head, waiting: [], reason: "orc read 1 of 2 check runs for " + head }))
  })

  test("a failed check run on a later page fails the verdict instead of passing the first page", async () => {
    const first = JSON.stringify({ total_count: 3, check_runs: [
      { id: 1, name: "lint", head_sha: head, status: "completed", conclusion: "success" },
      { id: 2, name: "docs", head_sha: head, status: "completed", conclusion: "success" }
    ] })
    const second = JSON.stringify({ total_count: 3, check_runs: [
      { id: 3, name: "test", head_sha: head, status: "completed", conclusion: "failure" }
    ] })
    const asked: Array<string> = []
    const verdict = await Effect.runPromise(readCiVerdict((_hostname, apiPath) => {
      asked.push(apiPath)
      return Effect.succeed(apiPath.includes("page=2") ? { stdout: second, stderr: "", exitCode: 0 } : { stdout: first, stderr: "", exitCode: 0 })
    }, "https://github.com/o/r/pull/9", head))
    expect(asked).toEqual(["repos/o/r/commits/" + head + "/check-runs?per_page=100", "repos/o/r/commits/" + head + "/check-runs?per_page=100&page=2"])
    expect(verdict).toEqual({ kind: "failed", headSha: head, failing: ["test"] })
  })

  test("a gh api failure on a later page stays pending instead of passing the first page", async () => {
    const first = JSON.stringify({ total_count: 2, check_runs: [
      { id: 1, name: "lint", head_sha: head, status: "completed", conclusion: "success" }
    ] })
    const verdict = await Effect.runPromise(readCiVerdict((_hostname, apiPath) =>
      apiPath.includes("page=2")
        ? Effect.succeed({ stdout: "", stderr: "HTTP 500", exitCode: 1 })
        : Effect.succeed({ stdout: first, stderr: "", exitCode: 0 }), "https://github.com/o/r/pull/9", head))
    expect(verdict.kind).toBe("pending")
    expect(ciVerdictLine(verdict)).toContain("orc could not read the check runs: gh api exited 1: HTTP 500")
  })
})
