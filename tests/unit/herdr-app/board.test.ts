import { expect, test } from "bun:test"
import { clickedSelection, laneFor, lanes, panelCommand, queueLine, selectionOnBoard, tasksInLane, titleClip, type BoardTask } from "../../../packages/herdr-app/src/board"
import { guardJson } from "../../../packages/herdr-app/src/guard"
import { boardBacklog, boardQueue } from "../../../packages/herdr-app/src/guard-board"

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

test("a card title that wraps to three lines shows two rather than three", () => {
  expect(titleClip.heightPx).toBe(2 * titleClip.lineHeightPx)
})

test("a closed task without an open PR, including one no beat has read, is not in Running or Awaiting you", () => {
  expect(laneFor({ ...task, status: "closed", prState: null }, new Set())).toBe("Done")
  expect(laneFor({ ...task, status: "closed", prState: "merged" }, new Set())).toBe("Done")
  expect(laneFor({ ...task, status: "closed", prState: "closed" }, new Set())).toBe("Done")
})

const queuedEntry = (taskId: string, machine: string | null, ahead?: number) => ({
  id: null, project: "/home/sam/work/orc", branch: `orc/${taskId}`, status: null, state: "queued", prLink: null, title: null, step: null,
  currentStep: null, questions: 0, endReason: null, kind: null, delivery: null, task: taskId, machine, worktree: null, ...(ahead === undefined ? {} : { ahead })
})

const startedRun = {
  id: "20261115-1", project: "/home/sam/work/orc", branch: "orc/orc-59", status: "running", state: "running", prLink: null, title: null, step: null,
  currentStep: null, questions: 0, endReason: null, kind: "ship", delivery: null, task: "orc-59", machine: "winbox", worktree: null
}

const queueOf = (runs: ReadonlyArray<unknown>) => {
  const read = guardJson(JSON.stringify({ schema: "orc.runs.v1", runs, machines: [] }), boardQueue)
  if (read.kind !== "ok") throw new Error(read.reason)
  return read.value
}

test("a queued task with no run says where it waits and how many are ahead instead of nothing", () => {
  const queued = queueOf([queuedEntry("orc-54", "winbox", 1), queuedEntry("orc-60", null, 4), startedRun])
  expect(queueLine(queued, "orc-54")).toBe("Queued on winbox, 1 ahead")
  expect(queueLine(queued, "orc-60")).toBe("Queued on this machine, 4 ahead")
})

test("a started run's task shows no queued line instead of one that outlives the queue", () => {
  expect(queueLine(queueOf([startedRun]), "orc-59")).toBeNull()
})

test("a queued entry from an older orc with no count ahead still says where it waits instead of refusing the runs", () => {
  expect(queueLine(queueOf([queuedEntry("orc-61", "winbox")]), "orc-61")).toBe("Queued on winbox")
})

test("a Board with no selection keeps the task panel closed instead of showing it", () => {
  expect(selectionOnBoard(null, [task])).toBeNull()
  expect(panelCommand(null, null)).toBe("layout.hide")
  expect(panelCommand(null, true)).toBe("layout.hide")
  expect(panelCommand(null, false)).toBeNull()
})

test("a second click on the selected card clears the selection instead of leaving the panel open", () => {
  expect(clickedSelection(null, "orc-1")).toBe("orc-1")
  expect(clickedSelection("orc-2", "orc-1")).toBe("orc-1")
  expect(clickedSelection("orc-1", "orc-1")).toBeNull()
  expect(panelCommand(clickedSelection("orc-1", "orc-1"), true)).toBe("layout.hide")
  expect(panelCommand(clickedSelection("orc-2", "orc-1"), false)).toBe("layout.show")
})

test("a selection of a task gone from the Board closes the panel instead of keeping it open", () => {
  expect(selectionOnBoard("orc-9", [task])).toBeNull()
  expect(selectionOnBoard("orc-1", [task])).toBe("orc-1")
  expect(selectionOnBoard("orc-9", null)).toBe("orc-9")
  expect(panelCommand(selectionOnBoard("orc-9", [task]), true)).toBe("layout.hide")
  expect(panelCommand(selectionOnBoard("orc-1", [task]), false)).toBe("layout.show")
  expect(panelCommand(selectionOnBoard("orc-1", [task]), true)).toBeNull()
})
