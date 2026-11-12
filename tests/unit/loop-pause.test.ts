import { describe, expect, test } from "bun:test"
import { askAfterFailures, nextStreak, pauseAfterFailures } from "../../packages/run/src/entities/agent/index"
import { loopAnswerOf, readLoopAnswer } from "../../packages/run/src/features/running-a-task/loop-pause"

const failTimes = (command: string, count: number) =>
  Array.from({ length: count }).reduce<ReturnType<typeof nextStreak>>((streak) => nextStreak(streak, command, true), null)

describe("the failure streak", () => {
  test("asks at three failures and pauses at six, instead of other counts", () => {
    expect(askAfterFailures).toBe(3)
    expect(pauseAfterFailures).toBe(6)
  })

  test("counts the same command failing again instead of starting over", () => {
    expect(failTimes("bun run test", 3)).toEqual({ command: "bun run test", failures: 3 })
  })

  test("starts over on a different failing command instead of adding to the last one", () => {
    expect(nextStreak(failTimes("bun run test", 5), "bun run lint", true)).toEqual({ command: "bun run lint", failures: 1 })
  })

  test("ends on a success of the same command instead of carrying the count", () => {
    expect(nextStreak(failTimes("bun run test", 5), "bun run test", false)).toBeNull()
  })
})

describe("the loop answer", () => {
  test("resumes Pi on an answer that opens with continue, keeping the captain's guidance", () => {
    expect(readLoopAnswer("Continue, but run the tests one file at a time")).toEqual({ kind: "continue", words: "Continue, but run the tests one file at a time" })
  })

  test("stops on stop, and on any answer it cannot read as continue instead of spending more quota", () => {
    expect(readLoopAnswer("stop").kind).toBe("stop")
    expect(readLoopAnswer("keep going").kind).toBe("stop")
    expect(readLoopAnswer("continued enough already").kind).toBe("stop")
  })

  test("reads only the looping answer among the run's answers, instead of a review answer", () => {
    expect(loopAnswerOf([{ question: "r2", answer: "continue" }])).toBeNull()
    expect(loopAnswerOf([{ question: "r2", answer: "Keep it" }, { question: "looping", answer: "stop" }])?.kind).toBe("stop")
  })
})
