import { describe, expect, test } from "bun:test"
import { type ChangedFile, ownerWordChanges, type PullRequestView } from "../../../packages/run/src/entities/pull-request/index"
import { beatMergeWaits } from "../../../packages/run/src/widgets/beat/yolo-merge"

const check = (conclusion: string) => ({ name: "test", workflowName: "ci", status: "COMPLETED", conclusion, startedAt: "2026-11-18T10:00:00Z" })

const view = (conclusion = "SUCCESS", state = "OPEN"): PullRequestView =>
  ({ state, headRefOid: "0".repeat(40), baseRefName: "main", statusCheckRollup: [check(conclusion)] })

const changed = (path: string, status = "modified", version = false): ChangedFile => ({ status, path, version })

describe("the beat merges a yolo project's green PR", () => {
  test("a green open PR of a yolo project has nothing to wait for instead of waiting for the captain", () => {
    expect(beatMergeWaits(true, view())).toEqual([])
    expect(ownerWordChanges([changed("packages/run/src/a.ts"), changed("docs/a.md", "added")])).toEqual([])
  })

  test("a red PR waits instead of being merged", () => {
    expect(beatMergeWaits(true, view("FAILURE"))).toEqual(["the check ci/test is red"])
  })

  test("a PR whose check has not reported waits instead of being merged", () => {
    expect(beatMergeWaits(true, { ...view(), statusCheckRollup: [{ ...check(""), status: "IN_PROGRESS" }] })).toEqual(["the check ci/test has not reported"])
  })

  test("a no-yolo project's green PR waits instead of being merged", () => {
    expect(beatMergeWaits(false, view())).toEqual(["the project has no yolo true, so its PRs merge only on the captain's word"])
  })

  test("a workflow change waits for the captain instead of being merged", () => {
    expect(ownerWordChanges([changed(".github/workflows/ci.yml")])).toEqual([
      "changes the workflow file .github/workflows/ci.yml, which waits for the captain's merge word"
    ])
  })

  test("a release, a deletion and a secret change wait for the captain instead of being merged", () => {
    expect(ownerWordChanges([changed("CHANGELOG.md"), changed("packages/run/package.json", "modified", true), changed("src/old.ts", "removed"), changed(".env.production")])).toEqual([
      "is a release, as it changes CHANGELOG.md, packages/run/package.json, which waits for the captain's merge word",
      "deletes src/old.ts, which waits for the captain's merge word",
      "changes the secret file .env.production, which waits for the captain's merge word"
    ])
  })

  test("a package.json change that keeps the version merges instead of reading as a release", () => {
    expect(ownerWordChanges([changed("package.json")])).toEqual([])
  })
})
