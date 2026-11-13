import { describe, expect, test } from "bun:test"
import type { ExpectedDecision } from "../../packages/run/src/entities/parked-runs/index"
import { answerArgs } from "../../packages/run/src/features/chat/chat-board-page"

describe("board answer arguments", () => {
  test("a held board carries its decision kind and hold generation", async () => {
    const expected: ExpectedDecision = { kind: "held", generation: 2 }
    expect(answerArgs("orc-1", { kind: "question", id: "question-1" }, "gRPC", expected)).toEqual(
      ["backlog", "answer", "orc-1", "--expect", "held", "--generation", "2", "question-1=gRPC"]
    )
  })

  test("a parked board carries its decision kind without a hold generation", async () => {
    const expected: ExpectedDecision = { kind: "parked" }
    expect(answerArgs("orc-1", { kind: "question", id: "question-1" }, "Keep it", expected)).toEqual(
      ["backlog", "answer", "orc-1", "--expect", "parked", "question-1=Keep it"]
    )
  })

  test("a reason board answers with words alone", async () => {
    const expected: ExpectedDecision = { kind: "held", generation: 0 }
    expect(answerArgs("orc-1", { kind: "reason" }, "yes", expected)).toEqual(
      ["backlog", "answer", "orc-1", "--expect", "held", "--generation", "0", "yes"]
    )
  })

  test("an unguarded answer keeps the plain words", async () => {
    expect(answerArgs("orc-1", { kind: "question", id: "question-1" }, "gRPC")).toEqual(
      ["backlog", "answer", "orc-1", "question-1=gRPC"]
    )
  })
})
