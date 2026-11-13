import { expect, test } from "bun:test"
import { chmod, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"
import { fakeQuota, orcOk, runnerTimeout, withFixture } from "../runner-helpers"

test("backlog distinguishes a scout PR's open, closed and merged states instead of leaving them unknown", async () => {
  await withFixture(async (fixture) => {
    await fakeQuota(fixture)
    await writeFile(join(fixture.home, "backlog", "dispatch.json"), JSON.stringify({
      machines: [{ name: "linux", slots: 4, start: ["true"] }],
      quota: { provider: "acme", command: ["orc-quota"], accounts: [{ name: "main", kind: "none" }], floorPercent: 15 }
    }))
    await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--kind", "scout"])
    await orcOk(fixture, ["beat"])
    await orcOk(fixture, ["backlog", "close", "orc-1", "done"])
    const task = join(fixture.home, "backlog", "closed", "orc-1.md")
    await writeFile(task, (await readFile(task, "utf8")).replace("\n---\n", '\npr: "https://github.com/example/repo/pull/1"\n---\n'))
    const state = join(fixture.dir, "pr-state")
    const gh = join(fixture.dir, "bin", "gh")
    await writeFile(gh, '#!/bin/sh\nprintf \'{"state":"%s","headRefOid":"abc","baseRefName":"main","statusCheckRollup":[]}\' "$(cat "$ORC_HOME/../pr-state")"\n')
    await chmod(gh, 0o755)
    const readState = async () => Schema.decodeSync(Schema.fromJsonString(Schema.Struct({
      tasks: Schema.Array(Schema.Struct({ id: Schema.String, prState: Schema.NullOr(Schema.Literals(["open", "closed", "merged"])) }))
    })))(await orcOk(fixture, ["backlog", "--json"])).tasks[0]?.prState
    expect(await readState()).toBeNull()
    await writeFile(state, "OPEN")
    await orcOk(fixture, ["beat"])
    expect(await readState()).toBe("open")
    await writeFile(state, "CLOSED")
    await orcOk(fixture, ["beat"])
    expect(await readState()).toBe("closed")
    await writeFile(state, "MERGED")
    await orcOk(fixture, ["beat"])
    expect(await readState()).toBe("merged")
  })
}, runnerTimeout)
