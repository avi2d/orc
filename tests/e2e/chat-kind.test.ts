import { describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { closeTask, orchestratorConfig, ranClosing, sessionFor, withFixture } from "./chat-helpers"

describe("orc chat with task kinds", () => {
  test("posts a closed scout with its report path where a shipped task posts its PR, instead of saying it has no PR", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const chat = sessionFor(fixture)
      expect(await chat.call("orc_backlog_add", { project: "orc", task: "# Map the parser\n", kind: "scout", machine: "mac" })).toBe("added orc-1 for orc on mac as a scout")
      await closeTask(fixture, "orc-1", [...ranClosing("done", "the run wrote its report", null), "report: \"/orc/runs/run-1/agent-report.md\""])
      await chat.postClosed()
      expect(chat.posted).toEqual(["orc-1 Map the parser closed done: the run wrote its report, report /orc/runs/run-1/agent-report.md"])
    })
  }, 60_000)

  test("marks an internal task on its file and posts its direct PR as a shipped task's, instead of dropping the mark", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await writeFile(join(fixture.home, "backlog", "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { mac: fixture.dir }, mode: "no-mistakes-prod-only" }] }))
      const chat = sessionFor(fixture)
      expect(await chat.call("orc_backlog_add", { project: "orc", task: "# Tidy the docs\n", internal: true })).toBe("added orc-1 for orc marked internal")
      expect(await readFile(join(fixture.home, "backlog", "new", "orc-1.md"), "utf8")).toContain("internal: true\n")
      await closeTask(fixture, "orc-1", ranClosing("done", "", "https://github.com/acme/orc/pull/8"))
      await chat.postClosed()
      expect(chat.posted).toEqual(["orc-1 Tidy the docs closed done, PR https://github.com/acme/orc/pull/8"])
    })
  }, 60_000)
})
