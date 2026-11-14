import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { BacklogTasks } from "../../packages/run/src/features/chat/chat-backlog"
import { closedLine } from "../../packages/run/src/features/chat/chat-closed"

describe("chat backlog decoding", () => {
  test("a closed task keeps its answered hold instead of dropping it", () => {
    const backlog = Schema.decodeSync(BacklogTasks)(JSON.stringify({
      tasks: [{
        id: "task-1",
        title: "Pick the API",
        project: "orc",
        kind: "ship",
        machine: null,
        dependsOn: [],
        created: "2026-10-27T10:00:00.000Z",
        hold: {
          reason: "two choices",
          until: null,
          questions: [{ id: "question-1", text: "REST or gRPC?", answer: { words: "gRPC", at: "2026-11-02T12:00:00.000Z" } }],
          answer: null
        },
        parked: null,
        status: "closed",
        outcome: "done",
        reason: "shipped",
        pr: null,
        report: null,
        answer: null,
        postedAt: null
      }],
      events: []
    }))
    const task = backlog.tasks.find((candidate) => candidate.id === "task-1")
    if (task === undefined || task.status !== "closed") {
      throw new Error("expected one closed task, got " + JSON.stringify(backlog.tasks))
    }
    expect(task.hold?.questions[0]?.answer?.words).toBe("gRPC")
  })
  test("an answered decision posts the answer instead of a missing report", () => {
    const backlog = Schema.decodeSync(BacklogTasks)(JSON.stringify({
      tasks: [{
        id: "orc-1",
        title: "Which button goes first",
        kind: "decision",
        hold: null,
        parked: null,
        status: "closed",
        outcome: "done",
        reason: "answered",
        pr: null,
        report: null,
        answer: { words: "The blue one", at: "2026-11-03T10:00:00.000Z" },
        postedAt: null
      }],
      events: []
    }))
    const task = backlog.tasks.find((candidate) => candidate.id === "orc-1")
    if (task === undefined || task.status !== "closed") {
      throw new Error("expected one closed decision, got " + JSON.stringify(backlog.tasks))
    }
    expect(closedLine(task)).toBe("orc-1 Which button goes first closed done: answered: The blue one")
  })
})
