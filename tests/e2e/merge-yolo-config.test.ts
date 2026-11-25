import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { orchestratorConfig, runOrc, sessionFor, withFixture } from "./chat-helpers"
import { writeProject } from "./merge-helpers"

const rejection = (pending: Promise<string>): Promise<string> =>
  pending.then((text) => "resolved: " + text, (error: unknown) => error instanceof Error ? error.message : String(error))

describe("yolo in projects.json", () => {
  test("a non-boolean yolo is refused naming the project instead of read as true", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await writeProject(fixture, { yolo: "yes" })
      expect(await rejection(sessionFor(fixture).call("orc_backlog_add", { project: "orc", task: "# Tidy the docs\n" }))).toContain("the project orc names yolo \"yes\", which is not true or false")
      expect(await readFile(join(fixture.home, "backlog", "new", "orc-1.md"), "utf8").catch(() => "no task file")).toBe("no task file")
    })
  }, 60_000)

  test("an entry with no yolo reads as before instead of gaining a yolo field", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const json: unknown = JSON.parse((await runOrc(fixture, ["backlog", "--json"])).stdout)
      expect(json).toMatchObject({ projects: [{ name: "orc", checkouts: { mac: fixture.dir } }] })
      expect(JSON.stringify(json)).not.toContain("yolo")
      expect(await sessionFor(fixture).call("orc_backlog_add", { project: "orc", task: "# Tidy the docs\n" })).toBe("added orc-1 for orc")
    })
  }, 60_000)
})
