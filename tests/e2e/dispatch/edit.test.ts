import { expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { orcOk, runOrc, withFixture } from "../runner-helpers"

test("orc backlog edit replaces a held task's title through the bin instead of refusing the verb or dropping its hold", async () => {
  await withFixture(async (fixture) => {
    await writeFile(join(fixture.home, "backlog", "dispatch.json"), JSON.stringify({
      machines: [{ name: "linux", slots: 1, start: ["true"] }],
      quota: { provider: "acme", command: ["orc-quota"], accounts: [{ name: "main", kind: "none" }], floorPercent: 15 }
    }))
    await orcOk(fixture, ["backlog", "add", "orc", "task.md"])
    await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--depends-on", "orc-1"])
    await orcOk(fixture, ["backlog", "hold", "orc-2", "--reason", "Choose the format"])
    await writeFile(join(fixture.dir, "new.md"), "# Do the thing in the folder map\n\nRead the new paths.\n")
    expect(await orcOk(fixture, ["backlog", "edit", "orc-2", "new.md"])).toBe("edited orc-2: Do the thing in the folder map\n")
    expect(JSON.parse(await orcOk(fixture, ["backlog", "--json"]))).toMatchObject({ tasks: [
      { id: "orc-1", title: "Do the thing" },
      { id: "orc-2", title: "Do the thing in the folder map", dependsOn: ["orc-1"], hold: { reason: "Choose the format", answer: null } }
    ] })
    const piped = await runOrc(fixture, ["backlog", "edit", "orc-9", "-"], {}, "# Another\n")
    expect({ code: piped.exitCode, error: piped.stderr.trim() }).toEqual({ code: 1, error: "orc: the backlog holds no orc-9" })
  })
})
