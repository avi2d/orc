import { expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { orcOk, runOrc, withFixture } from "../runner-helpers"

test("orc backlog drop closes a new task as dropped through the bin instead of refusing it the way close and stop do", async () => {
  await withFixture(async (fixture) => {
    await writeFile(join(fixture.home, "backlog", "dispatch.json"), JSON.stringify({
      machines: [{ name: "linux", slots: 1, start: ["true"] }],
      quota: { provider: "acme", command: ["orc-quota"], accounts: [{ name: "main", kind: "none" }], floorPercent: 15 }
    }))
    await orcOk(fixture, ["backlog", "add", "orc", "task.md"])
    const closed = await runOrc(fixture, ["backlog", "close", "orc-1", "failed"])
    expect({ code: closed.exitCode, error: closed.stderr.trim() }).toEqual({ code: 1, error: "orc: orc-1 is new, and only a started task closes" })
    expect(await orcOk(fixture, ["backlog", "drop", "orc-1", "no", "longer", "wanted"])).toBe("dropped orc-1: no longer wanted\n")
    expect(JSON.parse(await orcOk(fixture, ["backlog", "--json"]))).toMatchObject({ tasks: [
      { id: "orc-1", status: "closed", outcome: "dropped", reason: "no longer wanted", claim: null, postedAt: null }
    ] })
    expect(await orcOk(fixture, ["backlog"])).toContain("orc-1 orc dropped: no longer wanted")
    const again = await runOrc(fixture, ["backlog", "drop", "orc-1", "twice"])
    expect({ code: again.exitCode, error: again.stderr.trim() }).toEqual({ code: 1, error: "orc: orc-1 is already closed dropped" })
  })
})
