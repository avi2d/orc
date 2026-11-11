import { expect, test } from "bun:test"
import { backlog, guardJson, quotaSnapshot } from "../../../packages/herdr-app/src/guard"

test("refuses a backlog task with no title instead of counting it", () => {
  const text = JSON.stringify({ schema: "orc.backlog.v1", tasks: [{ id: "task-1" }] })
  expect(guardJson(text, backlog)).toEqual({ kind: "refused", reason: "tasks[0].title is missing" })
})

test("refuses a quota account without a title instead of displaying a blank name", () => {
  const text = JSON.stringify({ schemaVersion: 1, sources: { quota: { status: "ok", report: { accounts: [{}] } } } })
  expect(guardJson(text, quotaSnapshot)).toEqual({ kind: "refused", reason: "sources.quota.report.accounts[0].title is missing" })
})
