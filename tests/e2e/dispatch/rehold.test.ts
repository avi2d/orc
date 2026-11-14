import { expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"
import { fakeQuota, orcOk, runOrc, runnerTimeout, withFixture } from "../runner-helpers"

test("answering an earlier hold does not prevent a new hold or erase its prior decision", async () => {
  await withFixture(async (fixture) => {
    await fakeQuota(fixture)
    await writeFile(join(fixture.home, "backlog", "dispatch.json"), JSON.stringify({
      machines: [{ name: "linux", slots: 1, start: ["true"] }],
      quota: { provider: "acme", command: ["orc-quota"], accounts: [{ name: "main", kind: "none" }], floorPercent: 15 }
    }))
    await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--priority", "0"])
    await orcOk(fixture, ["backlog", "hold", "orc-1", "--reason", "Choose the format", "--question", "Which format?"])
    await orcOk(fixture, ["backlog", "answer", "orc-1", "question-1=JSON"])
    const reheld = await runOrc(fixture, ["backlog", "hold", "orc-1", "--reason", "Wait for the merge", "--until", "2026-12-01"])
    expect({ code: reheld.exitCode, error: reheld.stderr }).toEqual({ code: 0, error: "" })
    const document: unknown = JSON.parse(await orcOk(fixture, ["backlog", "--json"]))
    expect(document).toMatchObject({ tasks: [{
      id: "orc-1", status: "new",
      hold: {
        reason: "Wait for the merge", until: "2026-12-01", answer: null,
        history: [{ reason: "Choose the format", questions: [{ id: "question-1", text: "Which format?", answer: { words: "JSON" } }], answer: { words: "Which format?: JSON" } }]
      }
    }] })
    const readHold = async () => Schema.decodeSync(Schema.fromJsonString(Schema.Struct({ tasks: Schema.Array(Schema.Struct({ hold: Schema.Unknown })) })))(await orcOk(fixture, ["backlog", "--json"])).tasks[0]?.hold
    const before = await readHold()
    expect(await orcOk(fixture, ["beat"])).toContain("waits orc-1: held for the captain: Wait for the merge")
    await orcOk(fixture, ["backlog", "hold", "orc-1", "--reason", "Do not overwrite the gate"])
    expect(await readHold()).toEqual(before)
    await orcOk(fixture, ["backlog", "answer", "orc-1", "Merged"])
    await orcOk(fixture, ["backlog", "hold", "orc-1", "--reason", "Wait for deployment"])
    expect(await readHold()).toMatchObject({
      reason: "Wait for deployment", answer: null,
      history: [{ reason: "Choose the format", answer: { words: "Which format?: JSON" } }, { reason: "Wait for the merge", until: "2026-12-01", answer: { words: "Merged" } }]
    })
    await orcOk(fixture, ["backlog", "answer", "orc-1", "Deployed"])
    expect(await orcOk(fixture, ["beat"])).toContain("started orc-1")
    const started = await runOrc(fixture, ["backlog", "hold", "orc-1", "--reason", "Too late"])
    expect(started.exitCode).toBe(1)
    expect(started.stderr).toContain("only a new task is held")
    expect(await readHold()).toMatchObject({ reason: "Wait for deployment", answer: { words: "Deployed" } })
    await orcOk(fixture, ["runner", "start"], {
      ORC_TASK_ID: "orc-1", ORC_TASK_FILE: join(fixture.home, "backlog", "taken", "orc-1.md"),
      ORC_TASK_CHECKOUT: fixture.checkout, ORC_TASK_PROVIDER: "acme", ORC_TASK_TOKEN_FILE: ""
    })
    expect(await readFile(join(fixture.home, "runner", "orc-1.md"), "utf8")).toEndWith([
      "Held for the captain: Choose the format", "The captain answered: Which format?: JSON", "",
      "Held for the captain: Wait for the merge", "The captain answered: Merged", "",
      "Held for the captain: Wait for deployment", "The captain answered: Deployed"
    ].join("\n"))
  })
}, runnerTimeout)
