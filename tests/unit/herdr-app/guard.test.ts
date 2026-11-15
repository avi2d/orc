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

test("leaves a queued task out of the runs instead of refusing it for its null id", () => {
  const started = { id: "r1", project: "/p", branch: "b", status: "running", prLink: null, title: "t", step: null, questions: 0, endReason: null, worktree: null }
  const text = JSON.stringify({ schema: "orc.runs.v1", runs: [{ id: null, project: "/home/sam/work/kelp", branch: "orc/kelp-12", status: null, state: "queued", prLink: null, title: null, step: null, currentStep: null, questions: 0, endReason: null, kind: null, delivery: null, task: "kelp-12", machine: null, worktree: null }, started] })
  const guarded = guardJson(text, runs)
  expect(guarded.kind === "ok" ? guarded.value.runs.map((run) => run.id) : guarded).toEqual(["r1"])
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

test("refuses a run from an orc that prints no worktree instead of hiding its changes", () => {
  const text = JSON.stringify({ schema: "orc.runs.v1", runs: [{ id: "r1", project: "/p", branch: "b", status: "running", prLink: null, title: "t", step: null, questions: 0, endReason: null }] })
  expect(guardJson(text, runs)).toEqual({ kind: "refused", reason: "runs[0].worktree is missing" })
})

test("refuses a step from an orc that prints no model instead of showing a card without one", () => {
  const text = JSON.stringify({ schema: "orc.show.v1", steps: [{ id: 1, name: "implement", attempt: 1, status: "passed" }] })
  expect(guardJson(text, show)).toEqual({ kind: "refused", reason: "steps[0].model is missing" })
})

test("reads a step's model, thinking level and session file rather than dropping them", () => {
  const text = JSON.stringify({ schema: "orc.show.v1", steps: [{ id: 1, name: "implement", attempt: 1, status: "passed", model: "claude-opus-5-5", thinking: "high", piSessionFile: "/home/sam/.orc/runs/r1/sessions/s.jsonl" }] })
  const guarded = guardJson(text, show)
  expect(guarded.kind === "ok" ? guarded.value.steps : guarded).toEqual([{ id: 1, name: "implement", attempt: 1, status: "passed", model: "claude-opus-5-5", thinking: "high", piSessionFile: "/home/sam/.orc/runs/r1/sessions/s.jsonl" }])
})
