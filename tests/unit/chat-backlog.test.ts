import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { BacklogTasks } from "../../packages/run/src/chat-backlog"

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
        postedAt: null
      }]
    }))
    const task = backlog.tasks.find((candidate) => candidate.id === "task-1")
    if (task === undefined || task.status !== "closed") {
      throw new Error("expected one closed task, got " + JSON.stringify(backlog.tasks))
    }
    expect(task.hold?.questions[0]?.answer?.words).toBe("gRPC")
  })
})
