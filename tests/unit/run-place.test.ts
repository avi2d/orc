import { describe, expect, test } from "bun:test"
import { claimedMachineName } from "../../packages/run/src/features/running-a-task/run-place"
import { taskBranch, taskOfBranch } from "../../packages/run/src/entities/backlog/index"

describe("the machine a run records", () => {
  test("ORC_RUN_MACHINE gives the claimed machine name instead of the OS host name", () => {
    expect(claimedMachineName({ ORC_RUN_MACHINE: "linux-box", HOSTNAME: "Some-MacBook-Pro.local" })).toBe("linux-box")
  })

  test("a hand run with no claimed name records null instead of a guessed machine", () => {
    expect(claimedMachineName({})).toBeNull()
    expect(claimedMachineName({ ORC_RUN_MACHINE: "" })).toBeNull()
  })

  test("ORC_TASK_MACHINE alone is not read as the run's machine", () => {
    expect(claimedMachineName({ ORC_TASK_MACHINE: "linux" })).toBeNull()
  })
})

describe("the task a run records", () => {
  test("a task branch reads back as its task id", () => {
    expect(taskOfBranch(taskBranch("orc-36"))).toBe("orc-36")
  })

  test("a hand branch that names no task id reads as null instead of a made-up task", () => {
    expect(taskOfBranch("orc/test")).toBeNull()
    expect(taskOfBranch("feature/orc-36")).toBeNull()
    expect(taskOfBranch("orc/orc-36-parent")).toBeNull()
  })
})
