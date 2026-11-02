import { describe, expect, test } from "bun:test"
import { closeTask, orchestratorConfig, ranClosing, sessionFor, withFixture } from "./chat-helpers"

describe("orc chat with task kinds", () => {
  test("posts a closed scout with its report path where a shipped task posts its PR, instead of saying it has no PR", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const chat = sessionFor(fixture)
      expect(await chat.call("orc_backlog_add", { project: "orc", task: "# Map the parser\n", kind: "scout", machine: "mac" })).toBe("added task-1 for orc on mac as a scout")
      await closeTask(fixture, "task-1", [...ranClosing("done", "the run wrote its report", null), "report: \"/orc/runs/run-1/agent-report.md\""])
      await chat.postClosed()
      expect(chat.posted).toEqual(["task-1 Map the parser closed done: the run wrote its report, report /orc/runs/run-1/agent-report.md"])
    })
  }, 60_000)
})
