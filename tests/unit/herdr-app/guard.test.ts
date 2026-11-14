import { expect, test } from "bun:test"
import { backlog, guardJson, runs, show } from "../../../packages/herdr-app/src/guard"

test("refuses a backlog task with no title instead of counting it", () => {
  const text = JSON.stringify({ schema: "orc.backlog.v1", tasks: [{ id: "task-1" }] })
  expect(guardJson(text, backlog)).toEqual({ kind: "refused", reason: "tasks[0].title is missing" })
})

test("refuses a run from an orc that prints no title instead of showing a blank card", () => {
  const text = JSON.stringify({ schema: "orc.runs.v1", runs: [{ id: "r1", project: "/p", branch: "b", status: "running", prLink: null }] })
  expect(guardJson(text, runs)).toEqual({ kind: "refused", reason: "runs[0].title is missing" })
})

test("refuses a step status it has no mark for instead of marking it passed", () => {
  const text = JSON.stringify({ schema: "orc.show.v1", steps: [{ id: 1, name: "implement", attempt: 1, status: "paused" }] })
  expect(guardJson(text, show)).toEqual({ kind: "refused", reason: 'steps[0].status is "paused", not "running" or "passed" or "failed" or "skipped"' })
})

test("reads a parked task's open questions as their count, not as no question", () => {
  const text = JSON.stringify({ schema: "orc.backlog.v1", events: [], tasks: [{ id: "orc-34", title: "t", project: "orc", kind: "ship", status: "new", hold: null, parked: { questions: [{ id: "R2" }, { id: "R3" }] } }] })
  const guarded = guardJson(text, backlog)
  expect(guarded.kind === "ok" ? guarded.value.tasks[0]?.parked : guarded).toBe(2)
})
