import { describe, expect, test } from "bun:test"
import { sentBackAnswersOf, sentBackContinuePrompt, sentBackGuidance } from "../../packages/run/src/features/running-a-task/worker-question"

describe("the guidance for a sent-back pull request", () => {
  test("names the owner as the one who sent it back, not the captain by default", () => {
    expect(sentBackGuidance([{ question: "send-back", answer: "rename the flag", decider: "owner" }]))
      .toBe("Owner sent back the pull request this branch opened: rename the flag\nChange the branch to answer that review, and commit the change on it.")
  })

  test("names the agent when a CI check sent it back, not the owner", () => {
    const ci = [{ question: "send-back", answer: "lint is red", decider: "agent" as const }]
    expect(sentBackGuidance(ci)).toStartWith("Agent sent back the pull request this branch opened: lint is red")
    expect(sentBackContinuePrompt(ci)).not.toContain("Owner")
  })

  test("keeps each later answer under its own author", () => {
    const answers = [
      { question: "send-back", answer: "lint is red", decider: "agent" as const },
      { question: "send-back-2", answer: "rename the flag", decider: "owner" as const }
    ]
    expect(sentBackGuidance(answers)).toContain("Agent sent back the pull request this branch opened: lint is red\nOwner also wrote: rename the flag\n")
  })

  test("does not credit anyone when the answer records no decider", () => {
    const guidance = sentBackGuidance([{ question: "send-back", answer: "rename the flag" }])
    expect(guidance).toStartWith("The pull request this branch opened was sent back: rename the flag")
    expect(guidance).not.toMatch(/Owner|Agent|captain/)
  })

  test("takes only the send-back answers of a run", () => {
    const answers = [{ question: "send-back-2", answer: "a" }, { question: "ask-1", answer: "b" }]
    expect(sentBackAnswersOf(answers)).toEqual([{ question: "send-back-2", answer: "a" }])
  })
})
