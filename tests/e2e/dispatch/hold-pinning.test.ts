import { expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"
import { fakeQuota, orcOk, runOrc, runnerTimeout, withFixture, type Fixture } from "../runner-helpers"

const dispatched = async (fixture: Fixture): Promise<void> => {
  await fakeQuota(fixture)
  await writeFile(join(fixture.home, "backlog", "dispatch.json"), JSON.stringify({
    machines: [{ name: "linux", slots: 1, start: ["true"] }],
    quota: { provider: "acme", command: ["orc-quota"], accounts: [{ name: "main", kind: "none" }], floorPercent: 15 }
  }))
  await orcOk(fixture, ["backlog", "add", "orc", "task.md"])
}

const attentionIds = async (fixture: Fixture): Promise<ReadonlyArray<string>> => {
  const document = Schema.decodeSync(Schema.fromJsonString(Schema.Struct({
    items: Schema.Array(Schema.Struct({ id: Schema.String }))
  })))(await orcOk(fixture, ["attention", "--json"]))
  return document.items.map(({ id }) => id)
}

test("a board answer saved from the first hold does not release the same hold asked again", async () => {
  await withFixture(async (fixture) => {
    await dispatched(fixture)
    await orcOk(fixture, ["backlog", "hold", "orc-1", "--reason", "Choose the format"])
    await orcOk(fixture, ["backlog", "answer", "orc-1", "JSON"])
    await orcOk(fixture, ["backlog", "hold", "orc-1", "--reason", "Choose the format"])
    const stale = await runOrc(fixture, ["backlog", "answer", "orc-1", "--generation", "0", "late words"])
    expect(stale.exitCode).toBe(1)
    expect(stale.stderr).toContain("was reheld while orc read it")
    expect(JSON.parse(await orcOk(fixture, ["backlog", "--json"]))).toMatchObject({
      tasks: [{ id: "orc-1", hold: { reason: "Choose the format", answer: null, history: [{ reason: "Choose the format", answer: { words: "JSON" } }] } }]
    })
    await orcOk(fixture, ["backlog", "answer", "orc-1", "TOML"])
    expect(await orcOk(fixture, ["beat"])).toContain("started orc-1")
  })
}, runnerTimeout)

test("a board answer saved from the first questions does not answer the same questions asked again", async () => {
  await withFixture(async (fixture) => {
    await dispatched(fixture)
    await orcOk(fixture, ["backlog", "hold", "orc-1", "--reason", "Pick one", "--question", "Which format?"])
    await orcOk(fixture, ["backlog", "answer", "orc-1", "question-1=JSON"])
    await orcOk(fixture, ["backlog", "hold", "orc-1", "--reason", "Pick one", "--question", "Which format?"])
    const stale = await runOrc(fixture, ["backlog", "answer", "orc-1", "--generation", "0", "question-1=YAML"])
    expect(stale.exitCode).toBe(1)
    expect(stale.stderr).toContain("was reheld while orc read it")
    await orcOk(fixture, ["backlog", "answer", "orc-1", "question-1=TOML"])
    expect(await orcOk(fixture, ["beat"])).toContain("started orc-1")
  })
}, runnerTimeout)

test("a board without a saved generation still answers the first hold", async () => {
  await withFixture(async (fixture) => {
    await dispatched(fixture)
    await orcOk(fixture, ["backlog", "hold", "orc-1", "--reason", "Choose the format"])
    await orcOk(fixture, ["backlog", "answer", "orc-1", "--generation", "0", "JSON"])
    expect(await orcOk(fixture, ["beat"])).toContain("started orc-1")
  })
}, runnerTimeout)

test("a rehold on the same until date opens its own overdue item instead of reusing the answered one", async () => {
  await withFixture(async (fixture) => {
    await dispatched(fixture)
    await orcOk(fixture, ["backlog", "hold", "orc-1", "--reason", "Wait for legal", "--until", "2020-01-01"])
    await orcOk(fixture, ["beat"])
    expect(await attentionIds(fixture)).toEqual(["orc-1.overdue-wait.2020-01-01"])
    await orcOk(fixture, ["backlog", "answer", "orc-1", "done"])
    await orcOk(fixture, ["backlog", "hold", "orc-1", "--reason", "Wait for finance", "--until", "2020-01-01"])
    await orcOk(fixture, ["beat"])
    expect(await attentionIds(fixture)).toEqual(["orc-1.overdue-wait.2020-01-01.1"])
  })
}, runnerTimeout)
