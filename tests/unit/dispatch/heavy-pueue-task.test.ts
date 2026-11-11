import { describe, expect, test } from "bun:test"
import { exitCodeOf, queuedAhead, slotTasks, taskState } from "../../../packages/run/src/dispatch/heavy-pueue-task"

const task = (id: number, priority: number, status: unknown, command = "cmd " + String(id)) => ({
  id, created_at: "2026-11-11T10:00:00+00:00", original_command: command, command, path: "/w", envs: {}, group: "heavy",
  dependencies: [], priority, label: null, status
})

const statusText = (...tasks: ReadonlyArray<ReturnType<typeof task>>): string =>
  JSON.stringify({ tasks: Object.fromEntries(tasks.map((entry) => [String(entry.id), entry])), groups: {} })

const queued = { Queued: { enqueued_at: "2026-11-11T10:00:00+00:00" } }
const running = { Running: { enqueued_at: "2026-11-11T10:00:00+00:00", start: "2026-11-11T10:00:01+00:00" } }

describe("slotTasks", () => {
  test("a pueue 4 status reads each task's id, priority, status and command instead of the raw text", () => {
    expect(slotTasks(statusText(task(3, 1, queued, "bun test x")))).toEqual([{ id: 3, priority: 1, status: "Queued", command: "bun test x" }])
  })

  test("text that is not pueue JSON reads as no tasks instead of throwing", () => {
    expect(slotTasks("7 | Queued | fake command")).toEqual([])
    expect(slotTasks(JSON.stringify({ tasks: [1, 2] }))).toEqual([])
  })

  test("a task without a command or with a non-number priority is dropped instead of read with a made-up value", () => {
    const { command: _command, ...noCommand } = task(4, 0, queued)
    const textPriority = { ...task(6, 0, queued), priority: "high" }
    expect(slotTasks(JSON.stringify({ tasks: { 4: noCommand, 5: task(5, 0, queued), 6: textPriority } })).map((each) => each.id)).toEqual([5])
  })

  test("a task with no priority reads as pueue's default 0 instead of being dropped", () => {
    const { priority: _priority, ...noPriority } = task(3, 1, queued)
    expect(slotTasks(JSON.stringify({ tasks: { 3: noPriority } })).map((each) => each.priority)).toEqual([0])
  })
})

describe("queuedAhead", () => {
  const tasks = slotTasks(statusText(task(1, 0, running), task(2, 0, queued), task(3, 1, queued), task(5, 0, queued), task(6, 0, queued)))

  test("only queued tasks of higher priority or earlier at the same priority count instead of every task", () => {
    expect(queuedAhead(tasks, 5)).toBe(2)
  })

  test("a prioritized call counts only the prioritized queue ahead instead of the whole queue", () => {
    const prioritized = slotTasks(statusText(task(2, 0, queued), task(3, 1, queued), task(5, 1, queued)))
    expect(queuedAhead(prioritized, 5)).toBe(1)
  })
})

describe("taskState", () => {
  const done = (result: unknown) => ({ Done: { enqueued_at: "a", start: "b", end: "c", result } })

  test("a pueue 4 log entry reads its nested task status instead of none", () => {
    const log = JSON.stringify({ 7: { task: task(7, 0, done("Success")), output: "\"status\":{\"Queued\"" } })
    expect(taskState(log, 7)).toEqual({ status: "Done", result: "Success" })
  })

  test("a log naming another task reads as unknown instead of borrowing its status", () => {
    expect(taskState(JSON.stringify({ 8: { task: task(8, 0, queued) } }), 7)).toEqual({ status: "unknown" })
    expect(taskState("", 7)).toEqual({ status: "unknown" })
  })

  test("each waiting status keeps its name instead of collapsing to unknown", () => {
    for (const name of ["Queued", "Running", "Paused", "Stashed", "Locked"] as const) {
      expect(taskState(JSON.stringify({ 7: { status: { [name]: {} } } }), 7)).toEqual({ status: name })
    }
  })
})

describe("exitCodeOf", () => {
  test("a finished task maps its result to the caller's exit code instead of success", () => {
    expect(exitCodeOf({ status: "Done", result: "Success" })).toBe(0)
    expect(exitCodeOf({ status: "Done", result: { Failed: 3 } })).toBe(3)
    expect(exitCodeOf({ status: "Done", result: { FailedToSpawn: "no such file" } })).toBe(127)
    expect(exitCodeOf({ status: "Done", result: "Killed" })).toBe(1)
    expect(exitCodeOf({ status: "Done", result: "DependencyFailed" })).toBe(1)
  })

  test("an unfinished or unreadable task exits 1 instead of 0", () => {
    expect(exitCodeOf({ status: "Running" })).toBe(1)
    expect(exitCodeOf({ status: "unknown" })).toBe(1)
    expect(exitCodeOf({ status: "Done", result: { Failed: -2 } })).toBe(1)
  })
})
