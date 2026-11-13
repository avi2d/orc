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
    await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--kind", "scout"])
    await orcOk(fixture, ["beat"])
    await orcOk(fixture, ["backlog", "close", "orc-1", "done"])
    await orcOk(fixture, ["backlog", "close", "orc-2", "done"])
    const closed1 = join(fixture.home, "backlog", "closed", "orc-1.md")
    const closed2 = join(fixture.home, "backlog", "closed", "orc-2.md")
    await writeFile(closed1, (await readFile(closed1, "utf8")).replace("\n---\n", '\npr: "https://github.com/example/repo/pull/1"\n---\n'))
    await writeFile(closed2, (await readFile(closed2, "utf8")).replace("\n---\n", '\npr: "https://github.com/example/repo/pull/2"\n---\n'))
    const state1 = join(fixture.dir, "pr-state-1")
    const state2 = join(fixture.dir, "pr-state-2")
    const gh = join(fixture.dir, "bin", "gh")
    await writeFile(gh, '#!/bin/sh\ncase "$*" in\n*"/pull/1"*) f="$ORC_HOME/../pr-state-1" ;;\n*) f="$ORC_HOME/../pr-state-2" ;;\nesac\nprintf \'{"state":"%s","headRefOid":"abc","baseRefName":"main","statusCheckRollup":[]}\' "$(cat "$f")"\n')
    await chmod(gh, 0o755)
    const readStates = async () => {
      const tasks = Schema.decodeSync(Schema.fromJsonString(Schema.Struct({
        tasks: Schema.Array(Schema.Struct({ id: Schema.String, prState: Schema.NullOr(Schema.Literals(["open", "closed", "merged"])) }))
      })))(await orcOk(fixture, ["backlog", "--json"])).tasks
      return new Map(tasks.map((task) => [task.id, task.prState] as const))
    }
    expect(await readStates()).toEqual(new Map([["orc-1", null], ["orc-2", null]]))
    await writeFile(state1, "OPEN")
    await writeFile(state2, "OPEN")
    await orcOk(fixture, ["beat"])
    expect(await readStates()).toEqual(new Map([["orc-1", "open"], ["orc-2", "open"]]))
    await writeFile(state1, "CLOSED")
    await writeFile(state2, "MERGED")
    await orcOk(fixture, ["beat"])
    expect(await readStates()).toEqual(new Map([["orc-1", "closed"], ["orc-2", "merged"]]))
    await writeFile(state1, "MERGED")
    await writeFile(state2, "OPEN")
    await orcOk(fixture, ["beat"])
    expect(await readStates()).toEqual(new Map([["orc-1", "closed"], ["orc-2", "merged"]]))
  })
}, runnerTimeout)
