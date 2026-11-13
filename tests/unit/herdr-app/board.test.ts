import { expect, test } from "bun:test"
import { laneFor, lanes, tasksInLane, type BoardTask } from "../../../packages/herdr-app/src/board"
import { boardBacklog, guardJson } from "../../../packages/herdr-app/src/guard"

const task: BoardTask = {
  id: "orc-1", title: "A task", project: "orc", kind: "ship", created: "2026-01-01T00:00:00Z",
  status: "new", held: false, parked: false, prState: null
}

test("a task missing prState is refused instead of treated as Done", () => {
  const text = JSON.stringify({ schema: "orc.backlog.v1", tasks: [{ id: "orc-1", title: "A task", project: "orc", kind: "ship", created: "2026-01-01", status: "closed", hold: null, parked: null }], projects: [] })
  expect(guardJson(text, boardBacklog)).toMatchObject({ kind: "refused", reason: "tasks[0].prState is missing" })
})

test("a lane sorts oldest tasks first rather than input order", () => {
  const newer = { ...task, id: "orc-2", created: "2026-02-01" }
  expect(tasksInLane([newer, task], "Planned", null, new Set()).map((entry) => entry.id)).toEqual(["orc-1", "orc-2"])
})

test("a new task without a priority field is not in Backlog", () => {
  expect(lanes[0]).toBe("Backlog")
  expect(laneFor(task, new Set())).toBe("Planned")
})

test("a new task is not Running", () => {
  expect(laneFor(task, new Set())).toBe("Planned")
})

test("a held task and a closed task with an open PR are not in Planned or Done", () => {
  expect(laneFor({ ...task, held: true }, new Set())).toBe("Awaiting you")
  expect(laneFor({ ...task, status: "closed", prState: "open" }, new Set())).toBe("Awaiting you")
  expect(laneFor({ ...task, parked: true }, new Set())).toBe("Awaiting you")
  expect(laneFor(task, new Set(["orc-1"]))).toBe("Awaiting you")
})

test("a started task is not in Planned", () => {
  expect(laneFor({ ...task, status: "started" }, new Set())).toBe("Running")
  expect(laneFor({ ...task, status: "taken" }, new Set())).toBe("Running")
})

test("a closed task without an open PR is not in Running", () => {
  expect(laneFor({ ...task, status: "closed", prState: null }, new Set())).toBe("Done")
  expect(laneFor({ ...task, status: "closed", prState: "merged" }, new Set())).toBe("Done")
  expect(laneFor({ ...task, status: "closed", prState: "closed" }, new Set())).toBe("Done")
})
