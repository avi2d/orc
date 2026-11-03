import { describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type Fixture, orchestratorConfig, runOrc, withFixture } from "./chat-helpers"

const writeProjects = (fixture: Fixture, instructions: string): Promise<void> =>
  writeFile(join(fixture.home, "backlog", "projects.json"), JSON.stringify({
    projects: [{ name: "winbox", checkouts: { mac: fixture.dir }, instructions }, { name: "orc", checkouts: { mac: fixture.dir } }]
  }))

const piArgs = async (fixture: Fixture): Promise<string> => readFile(fixture.piLog, "utf8").catch(() => "")

describe("orc chat with a project's instructions file", () => {
  test("names the rules and the project's instructions on the first line and hands pi both instead of the rules alone", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const rules = join(fixture.home, "orchestrator.md")
      const instructions = join(fixture.home, "backlog", "winbox-ru.md")
      await writeFile(rules, "# Rules\n")
      await writeFile(instructions, "Check word: PELICAN-7.\n")
      await writeProjects(fixture, "winbox-ru.md")
      const result = await runOrc(fixture, ["chat"])
      expect(result.exitCode).toBe(0)
      expect(result.stdout.split("\n")[0]).toBe("orc chat loaded the rules in " + rules + " and the instructions for winbox in " + instructions)
      const log = await piArgs(fixture)
      expect(log).toContain("--append-system-prompt\n" + rules + "\n")
      expect(log).toContain("--append-system-prompt\nThe instructions file for the project winbox, " + instructions + ":\n\nCheck word: PELICAN-7.\n")
    })
  }, 60_000)

  test("names the instructions after a missing rules file instead of dropping them with the rules", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const instructions = join(fixture.dir, "winbox-ru.md")
      await writeFile(instructions, "Check word: PELICAN-7.\n")
      await writeProjects(fixture, instructions)
      const result = await runOrc(fixture, ["chat"])
      expect(result.exitCode).toBe(0)
      expect(result.stdout.split("\n")[0]).toBe(
        "orc chat found no rules at " + join(fixture.home, "orchestrator.md") + "; it loaded the instructions for winbox in " + instructions
      )
      expect(await piArgs(fixture)).toContain("Check word: PELICAN-7.")
    })
  }, 60_000)

  test("refuses a project naming a missing instructions file before pi starts instead of chatting without it", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await writeProjects(fixture, "gone.md")
      const result = await runOrc(fixture, ["chat"])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain(
        "the project winbox names the instructions file " + join(fixture.home, "backlog", "gone.md") + ", which is no file"
      )
      expect(await piArgs(fixture)).toBe("")
    })
  }, 60_000)
})
