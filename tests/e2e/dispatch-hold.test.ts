import { describe, expect, test } from "bun:test"
import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { addTasks, backlogTask, beatTimeout, isRecord, orcOk, runOrc, settledStarts, startedLines, startSettleMillis, withFixture } from "./dispatch-helpers"

describe("orc backlog hold and answer", () => {
  test("a held task waits on every beat with its reason and starts only once answered, instead of starting while held", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      await addTasks(fixture, 1)
      expect(await orcOk(fixture, ["backlog", "hold", "orc-1", "--reason", "which API shape"])).toBe("held orc-1: which API shape\n")
      expect(await orcOk(fixture, ["beat"])).toContain("waits orc-1: held for the captain: which API shape")
      expect(await orcOk(fixture, ["beat"])).toContain("waits orc-1: held for the captain: which API shape")
      await Bun.sleep(startSettleMillis)
      expect(await startedLines(fixture)).toEqual([])
      expect(await orcOk(fixture, ["backlog", "answer", "orc-1", "the REST one"])).toBe("answered orc-1, so the beat may start it\n")
      expect(await orcOk(fixture, ["beat"])).toContain("started orc-1")
      expect(await settledStarts(fixture, 1)).toHaveLength(1)
    })
  }, beatTimeout)

  test("a hold whose until date has passed still waits for the answer instead of releasing on the date", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      await addTasks(fixture, 1)
      expect(await orcOk(fixture, ["backlog", "hold", "orc-1", "--reason", "budget", "--until", "2020-01-31"])).toBe("held orc-1: budget, until 2020-01-31\n")
      expect(await orcOk(fixture, ["beat"])).toContain("waits orc-1: held for the captain: budget, until 2020-01-31")
      await Bun.sleep(startSettleMillis)
      expect(await startedLines(fixture)).toEqual([])
    })
  }, beatTimeout)

  test("the backlog shows the reason, the date and the answer word for word instead of a bare new task", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      await addTasks(fixture, 2)
      await orcOk(fixture, ["backlog", "hold", "orc-1", "--reason", "which API shape", "--until", "2026-12-01"])
      await orcOk(fixture, ["backlog", "hold", "orc-2", "--reason", "go or no go"])
      const words = "Go, but:\n  keep the  old \"v1\" path — for now"
      const before = Date.now()
      await orcOk(fixture, ["backlog", "answer", "orc-2", words])
      expect(await backlogTask(fixture, "orc-1")).toMatchObject({ status: "new", hold: { reason: "which API shape", until: "2026-12-01", answer: null } })
      const answered = await backlogTask(fixture, "orc-2")
      expect(answered).toMatchObject({ status: "new", hold: { reason: "go or no go", until: null, answer: { words } } })
      const at = isRecord(answered) && isRecord(answered.hold) && isRecord(answered.hold.answer) ? String(answered.hold.answer.at) : ""
      expect(Date.parse(at)).toBeGreaterThanOrEqual(before - 1_000)
      const board = await orcOk(fixture, ["backlog"])
      expect(board).toContain("orc-1 P0 orc held (which API shape) Do the thing")
      expect(board).toContain("orc-2 P0 orc Do the thing")
    })
  }, beatTimeout)

  test("answer joins the words it is given with one space instead of dropping all but the first", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      await addTasks(fixture, 1)
      await orcOk(fixture, ["backlog", "hold", "orc-1", "--reason", "which API shape"])
      await orcOk(fixture, ["backlog", "answer", "orc-1", "use", "the", "REST", "one"])
      expect(await backlogTask(fixture, "orc-1")).toMatchObject({ hold: { answer: { words: "use the REST one" } } })
    })
  }, beatTimeout)

  test("holding a held task again keeps the first reason instead of replacing it", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      await addTasks(fixture, 1)
      await orcOk(fixture, ["backlog", "hold", "orc-1", "--reason", "first reason", "--until", "2026-12-01"])
      expect(await orcOk(fixture, ["backlog", "hold", "orc-1", "--reason", "second reason"])).toBe("orc-1 is already held: first reason, until 2026-12-01\n")
      expect(await backlogTask(fixture, "orc-1")).toMatchObject({ hold: { reason: "first reason", until: "2026-12-01", answer: null } })
    })
  }, beatTimeout)

  test("a taken task is refused a hold instead of moved back to new under its beat", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      await addTasks(fixture, 1)
      const backlog = join(fixture.dir, "home", "backlog")
      const text = await readFile(join(backlog, "new", "orc-1.md"), "utf8")
      const claimed = "\nbeat: \"beat-1\"\ntaken_for: \"mac\"\naccount: \"main\"\ntaken_at: \"2026-11-02T10:01:00.000Z\"\n---\n"
      await writeFile(join(backlog, "taken", "orc-1.md"), text.replace("\n---\n", claimed))
      await rm(join(backlog, "new", "orc-1.md"))
      const refused = await runOrc(fixture, ["backlog", "hold", "orc-1", "--reason", "wait"])
      expect([refused.exitCode, refused.stderr.trim()]).toEqual([1, "orc: orc-1 is taken, and only a new task is held"])
      expect(await backlogTask(fixture, "orc-1")).toMatchObject({ status: "taken", hold: null })
    })
  }, beatTimeout)

  test("hold refuses an unknown task, a started or closed one and a missing reason instead of writing a hold", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      await addTasks(fixture, 2)
      await orcOk(fixture, ["beat"])
      const refusal = async (args: ReadonlyArray<string>): Promise<readonly [number, string]> => {
        const result = await runOrc(fixture, args)
        return [result.exitCode, result.stderr.split("\n")[0] ?? ""]
      }
      expect(await refusal(["backlog", "hold", "orc-9", "--reason", "why"])).toEqual([1, "orc: the backlog holds no orc-9"])
      expect(await refusal(["backlog", "hold", "orc-1", "--reason", "why"])).toEqual([1, "orc: orc-1 is started, and only a new task is held"])
      await orcOk(fixture, ["backlog", "close", "orc-1", "done"])
      expect(await refusal(["backlog", "hold", "orc-1", "--reason", "why"])).toEqual([1, "orc: orc-1 is closed, and only a new task is held"])
      expect((await refusal(["backlog", "hold", "orc-2"]))[1]).toBe("orc backlog hold takes --reason and why the task waits for the captain")
      expect((await refusal(["backlog", "hold", "orc-2", "--reason", " "]))[1]).toBe("orc backlog hold takes --reason and why the task waits for the captain")
      expect((await refusal(["backlog", "hold", "orc-2", "--reason", "why", "--until", "next week"]))[1]).toBe("orc backlog hold takes a YYYY-MM-DD date after --until, got \"next week\"")
      expect(await backlogTask(fixture, "orc-2")).toMatchObject({ hold: null })
    })
  }, beatTimeout)

  test("answer refuses a task that is not held, or already answered, instead of recording words on it", async () => {
    await withFixture({ mac: 1, linux: 1, floorPercent: 15 }, async (fixture) => {
      await addTasks(fixture, 1)
      const refused = await runOrc(fixture, ["backlog", "answer", "orc-1", "yes"])
      expect([refused.exitCode, refused.stderr.trim()]).toEqual([1, "orc: orc-1 is not held"])
      await orcOk(fixture, ["backlog", "hold", "orc-1", "--reason", "why"])
      await orcOk(fixture, ["backlog", "answer", "orc-1", "yes"])
      const again = await runOrc(fixture, ["backlog", "answer", "orc-1", "no"])
      expect([again.exitCode, again.stderr.trim()]).toEqual([1, "orc: orc-1 is not held: its hold was answered"])
      expect(await backlogTask(fixture, "orc-1")).toMatchObject({ hold: { answer: { words: "yes" } } })
      expect((await runOrc(fixture, ["backlog", "answer", "orc-1"])).stderr.split("\n")[0]).toBe("orc backlog answer takes a task id and the captain's words")
    })
  }, beatTimeout)
})
