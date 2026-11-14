import { expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"
import { fakeQuota, orcOk, runnerTimeout, withFixture } from "../runner-helpers"

test("a done ship prerequisite with an open PR cannot start an ordinary ship dependent before its merge", async () => {
  await withFixture(async (fixture) => {
    await fakeQuota(fixture)
    await writeFile(join(fixture.home, "backlog", "dispatch.json"), JSON.stringify({
      machines: [{ name: "linux", slots: 4, start: ["true"] }],
      quota: { provider: "acme", command: ["orc-quota"], accounts: [{ name: "main", kind: "none" }], floorPercent: 15 }
    }))
    await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--priority", "0"])
    await orcOk(fixture, ["beat"])
    await orcOk(fixture, ["backlog", "close", "orc-1", "done"])
    const closed = join(fixture.home, "backlog", "closed", "orc-1.md")
    const text = await readFile(closed, "utf8")
    await writeFile(closed, text.replace("\n---\n", '\npr: "https://github.com/example/repo/pull/1"\n---\n'))
    await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--priority", "0", "--depends-on", "orc-1"])
    await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--priority", "0", "--kind", "scout", "--depends-on", "orc-1"])
    const readTasks = async () => Schema.decodeSync(Schema.fromJsonString(Schema.Struct({
      tasks: Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String, wait: Schema.NullOr(Schema.String) }))
    })))(await orcOk(fixture, ["backlog", "--json"])).tasks
    expect(await readTasks()).toContainEqual({ id: "orc-2", status: "new", wait: "waits on orc-1" })
    const waiting = await orcOk(fixture, ["beat"])
    expect(waiting).toContain("waits orc-2: waits on orc-1")
    expect(waiting).not.toContain("started orc-2")
    expect(waiting).toContain("started orc-3")
    await mkdir(join(fixture.home, "backlog", "events"), { recursive: true })
    await writeFile(join(fixture.home, "backlog", "events", "orc-1.merged.json"), JSON.stringify({ at: "2026-11-13T12:00:00.000Z", text: "merged" }))
    expect(await readTasks()).toContainEqual({ id: "orc-2", status: "new", wait: null })
    expect(await orcOk(fixture, ["beat"])).toContain("started orc-2")
    await orcOk(fixture, ["backlog", "close", "orc-3", "done"])
    await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--priority", "0", "--depends-on", "orc-3"])
    expect(await orcOk(fixture, ["beat"])).toContain("started orc-4")
  })
}, runnerTimeout)
