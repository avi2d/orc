import { expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"
import { fakeQuota, orcOk, runnerTimeout, withFixture } from "../runner-helpers"

const BacklogTasks = Schema.fromJsonString(Schema.Struct({
  tasks: Schema.Array(Schema.Struct({
    id: Schema.String,
    waiting: Schema.NullOr(Schema.Struct({ kind: Schema.String, detail: Schema.NullOr(Schema.String), at: Schema.optional(Schema.NullOr(Schema.String)) })),
    prState: Schema.NullOr(Schema.String)
  }))
}))

const withPr = async (file: string, pr: string): Promise<void> => {
  await writeFile(file, (await readFile(file, "utf8")).replace("\n---\n", "\npr: " + JSON.stringify(pr) + "\n---\n"))
}

test("backlog --json says why each new task waits and that a PR merged, instead of leaving a board to guess Backlog from Planned and Awaiting from Done", async () => {
  await withFixture(async (fixture) => {
    await fakeQuota(fixture)
    const backlog = join(fixture.home, "backlog")
    await writeFile(join(backlog, "dispatch.json"), JSON.stringify({
      machines: [{ name: "linux", slots: 1, start: ["sh", "-c", "echo started"] }],
      quota: { provider: "acme", command: ["orc-quota"], accounts: [{ name: "main", kind: "none" }], floorPercent: 15 }
    }))
    await orcOk(fixture, ["backlog", "add", "orc", "task.md"])
    await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--priority", "0"])
    await orcOk(fixture, ["backlog", "hold", "orc-2", "--reason", "which API shape"])
    await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--priority", "0"])
    await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--priority", "0"])
    await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--priority", "0"])
    await orcOk(fixture, ["backlog", "depend", "orc-3", "--on", "orc-4"])
    const waiting = async () => new Map(Schema.decodeSync(BacklogTasks)(await orcOk(fixture, ["backlog", "--json"])).tasks.map((task) => [task.id, task.waiting] as const))
    expect((await waiting()).get("orc-5")).toEqual({ kind: "room", detail: null, at: null })
    const beat = await orcOk(fixture, ["beat"])
    expect(beat).toContain("started orc-4")
    expect(beat).toContain("waits orc-5: no machine with a checkout of orc has room")
    const after = await waiting()
    expect(after.get("orc-1")).toEqual({ kind: "no-priority", detail: "no priority" })
    expect(after.get("orc-2")).toEqual({ kind: "held", detail: "held for the captain: which API shape" })
    expect(after.get("orc-3")).toEqual({ kind: "depends", detail: "waits on orc-4" })
    expect(after.get("orc-4")).toBeNull()
    expect(after.get("orc-5")).toMatchObject({ kind: "room", detail: "no machine with a checkout of orc has room" })
    expect(after.get("orc-5")?.at).toEqual(expect.any(String))
    await orcOk(fixture, ["backlog", "close", "orc-4", "done"])
    await withPr(join(backlog, "closed", "orc-4.md"), "https://github.com/example/repo/pull/4")
    await mkdir(join(backlog, "events"), { recursive: true })
    await writeFile(join(backlog, "events", "orc-4.merged.json"), JSON.stringify({ at: "2026-11-15T10:00:00.000Z", text: "orc-4 merged: https://github.com/example/repo/pull/4" }))
    const closed = Schema.decodeSync(BacklogTasks)(await orcOk(fixture, ["backlog", "--json"])).tasks.find((task) => task.id === "orc-4")
    expect(closed).toMatchObject({ waiting: null, prState: "merged" })
  })
}, runnerTimeout)
