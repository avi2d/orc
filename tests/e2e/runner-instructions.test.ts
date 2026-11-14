import { describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { binPath, fakeQuota, type Fixture, mainToken, orcOk, orcThere, queuedArgs, runnerTimeout, withFixture } from "./runner-helpers"

const instructionsText = "Answer the captain in Russian. Check word: PELICAN-7.\n"

const writeProject = async (fixture: Fixture, start: ReadonlyArray<string>): Promise<void> => {
  await writeFile(join(fixture.home, "backlog", "atlas-rules.md"), instructionsText)
  await writeFile(join(fixture.home, "backlog", "projects.json"), JSON.stringify({
    projects: [{ name: "orc", checkouts: { linux: fixture.checkout }, instructions: "atlas-rules.md" }]
  }))
  await writeFile(join(fixture.home, "backlog", "dispatch.json"), JSON.stringify({
    machines: [{ name: "linux", slots: 1, start }],
    quota: { provider: "acme", command: ["orc-quota"], accounts: [{ name: "main", tokenFile: mainToken }], floorPercent: 15 }
  }))
  await fakeQuota(fixture)
  await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
  await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--priority", "0", "--machine", "linux"])
  await orcOk(fixture, ["beat"])
}

const instructionsArg = (added: ReadonlyArray<string> | null): string | undefined => {
  const at = added?.indexOf("--instructions") ?? -1
  return at < 0 ? undefined : added?.[at + 1]
}

describe("orc runner start with a project's instructions file", () => {
  test("the beat queues orc run with --instructions naming a copy of the project's file instead of dropping it", async () => {
    await withFixture(async (fixture) => {
      await writeProject(fixture, [process.execPath, binPath, "runner", "start"])
      const added = await queuedArgs(fixture)
      const file = join(fixture.home, "runner", "orc-1.instructions", "atlas-rules.md")
      expect(instructionsArg(added)).toBe(file)
      expect(added?.slice(-4)).toEqual(["--instructions", file, "--token-file", mainToken])
      expect(await readFile(file, "utf8")).toBe(instructionsText)
    })
  }, runnerTimeout)

  test("a start through a command writes the instructions on the far side instead of naming a dispatcher path", async () => {
    await withFixture(async (fixture) => {
      const far = join(fixture.dir, "far-home")
      await writeProject(fixture, [process.execPath, binPath, "runner", "start", "--", ...orcThere(far)])
      const file = instructionsArg(await queuedArgs(fixture)) ?? ""
      expect(file.startsWith(join(far, "runner") + "/")).toBe(true)
      expect(file.endsWith("/atlas-rules.md")).toBe(true)
      expect(await readFile(file, "utf8")).toBe(instructionsText)
    })
  }, runnerTimeout)
})
