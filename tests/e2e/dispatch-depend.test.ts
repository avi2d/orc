import { describe, expect, test } from "bun:test"
import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { addTasks, backlogTask, beatTimeout, type Fixture, orcOk, runOrc, withFixture } from "./dispatch-helpers"

const dependsOnLine = async (fixture: Fixture, folder: "new" | "taken", id: string): Promise<string> => {
  const text = await readFile(join(fixture.dir, "home", "backlog", folder, id + ".md"), "utf8")
  return text.split("\n").find((line) => line.startsWith("depends_on:")) ?? ""
}

describe("orc backlog depend", () => {
  test("a new task given dependencies waits for them at the next beat instead of starting", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      await addTasks(fixture, 3)
      expect(await orcOk(fixture, ["backlog", "depend", "orc-1", "--on", "orc-2,orc-3"])).toBe("orc-1 now waits on orc-2, orc-3\n")
      expect(await dependsOnLine(fixture, "new", "orc-1")).toBe("depends_on: [\"orc-2\",\"orc-3\"]")
      expect(await orcOk(fixture, ["backlog", "depend", "orc-1", "--on", "orc-2,orc-3"])).toBe("orc-1 already waits on orc-2, orc-3\n")
      const beat = await orcOk(fixture, ["beat"])
      expect(beat).toContain("waits orc-1: waits on orc-2")
      expect(await backlogTask(fixture, "orc-1")).toMatchObject({ status: "new" })
    })
  }, beatTimeout)

  test("clearing a held task's dependencies keeps its hold instead of dropping it", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      await addTasks(fixture, 2)
      await orcOk(fixture, ["backlog", "depend", "orc-1", "--on", "orc-2"])
      await orcOk(fixture, ["backlog", "hold", "orc-1", "--reason", "which API shape"])
      expect(await orcOk(fixture, ["backlog", "depend", "orc-1", "--clear"])).toBe("orc-1 now waits on no task\n")
      expect(await dependsOnLine(fixture, "new", "orc-1")).toBe("depends_on: []")
      expect(await backlogTask(fixture, "orc-1")).toMatchObject({ status: "new", hold: { reason: "which API shape" } })
    })
  }, beatTimeout)

  test("depend refuses an unknown task, a loop and a taken task instead of writing a dependency", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      await addTasks(fixture, 2)
      const refusal = async (args: ReadonlyArray<string>): Promise<readonly [number, string]> => {
        const result = await runOrc(fixture, args)
        return [result.exitCode, result.stderr.split("\n")[0] ?? ""]
      }
      expect(await refusal(["backlog", "depend", "orc-9", "--clear"])).toEqual([1, "orc: the backlog holds no orc-9"])
      expect(await refusal(["backlog", "depend", "orc-1", "--on", "orc-9"])).toEqual([1, "orc: the backlog holds no task orc-9"])
      expect(await refusal(["backlog", "depend", "orc-1", "--on", "orc-1"])).toEqual([1, "orc: orc-1 cannot wait on itself"])
      await orcOk(fixture, ["backlog", "depend", "orc-2", "--on", "orc-1"])
      expect(await refusal(["backlog", "depend", "orc-1", "--on", "orc-2"])).toEqual([1, "orc: orc-2 already waits on orc-1, so orc-1 waiting on orc-2 would hold both forever"])
      expect((await refusal(["backlog", "depend", "orc-1", "--on", "next"]))[1]).toBe("orc backlog depend takes comma separated task ids after --on, got \"next\"")
      expect((await refusal(["backlog", "depend", "orc-1"]))[1]).toBe("orc backlog depend takes --on and the task ids it waits for, or --clear")
      expect(await dependsOnLine(fixture, "new", "orc-1")).toBe("depends_on: []")
      const backlog = join(fixture.dir, "home", "backlog")
      const text = await readFile(join(backlog, "new", "orc-1.md"), "utf8")
      const claimed = "\nbeat: \"beat-1\"\ntaken_for: \"mac\"\naccount: \"main\"\ntaken_at: \"2026-11-02T10:01:00.000Z\"\n---\n"
      await writeFile(join(backlog, "taken", "orc-1.md"), text.replace("\n---\n", claimed))
      await rm(join(backlog, "new", "orc-1.md"))
      expect(await refusal(["backlog", "depend", "orc-1", "--clear"])).toEqual([1, "orc: orc-1 is taken, and only a new or held task takes other dependencies"])
      expect(await dependsOnLine(fixture, "taken", "orc-1")).toBe("depends_on: []")
    })
  }, beatTimeout)

  test("a task verb on a machine with no backlog names where the backlog lives instead of saying the task is missing", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      const backlog = join(fixture.dir, "home", "backlog")
      await rm(backlog, { recursive: true })
      const refused = await runOrc(fixture, ["backlog", "depend", "orc-1", "--clear"])
      expect([refused.exitCode, refused.stderr.trim()]).toEqual([1, "orc: no backlog at " + backlog + ": the backlog lives on the machine that runs orc beat, so run this command there"])
      expect(await orcOk(fixture, ["backlog"])).toBe("no backlog at " + backlog + ": the backlog lives on the machine that runs orc beat, so run this command there\n")
    })
  }, beatTimeout)
})
