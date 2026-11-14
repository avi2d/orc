import { expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { orcOk, runOrc, runnerTimeout, withFixture } from "../runner-helpers"

test("thread --json lists a hold, its question and answer, a second hold and a note in the order they were said, not grouped by file", async () => {
  await withFixture(async (fixture) => {
    await writeFile(join(fixture.home, "backlog", "dispatch.json"), JSON.stringify({
      machines: [{ name: "linux", slots: 1, start: ["true"] }],
      quota: { provider: "acme", command: ["orc-quota"], accounts: [{ name: "main", kind: "none" }], floorPercent: 15 }
    }))
    await orcOk(fixture, ["backlog", "add", "orc", "task.md"])
    await orcOk(fixture, ["backlog", "hold", "orc-1", "--reason", "Choose the format", "--question", "Which format?"])
    await orcOk(fixture, ["backlog", "answer", "orc-1", "question-1=JSON"])
    await orcOk(fixture, ["backlog", "hold", "orc-1", "--reason", "Wait for the merge"])
    await orcOk(fixture, ["backlog", "note", "orc-1", "the merge waits on review"])
    const thread: unknown = JSON.parse(await orcOk(fixture, ["backlog", "thread", "orc-1", "--json"]))
    expect(thread).toMatchObject({
      schema: "orc.thread.v1",
      task: "orc-1",
      entries: [
        { kind: "hold", who: "user", id: null, text: "Choose the format" },
        { kind: "question", who: "user", id: "hold-1/question-1", text: "Which format?" },
        { kind: "answer", who: "user", id: "hold-1/question-1", text: "JSON" },
        { kind: "hold", who: "user", id: null, text: "Wait for the merge" },
        { kind: "note", who: "user", id: null, text: "the merge waits on review" }
      ]
    })
    expect(thread).toHaveProperty("entries.length", 5)
    const plain = await orcOk(fixture, ["backlog", "thread", "orc-1"])
    expect(plain.trim().split("\n").map((line) => line.split(/\s{2,}/)[2] ?? "")).toEqual(["KIND", "hold", "question", "answer", "hold", "note"])
    const unknown = await runOrc(fixture, ["backlog", "thread", "orc-9"])
    expect({ code: unknown.exitCode, error: unknown.stderr.trim() }).toEqual({ code: 1, error: "orc: the backlog holds no orc-9" })
  })
}, runnerTimeout)
