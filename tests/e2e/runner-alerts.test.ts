import { describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type Fixture, mainToken, type OrcResult, runnerTimeout, runOrc, withFixture } from "./runner-helpers"
import { watchGroup } from "../../packages/run/src/features/heavy-commands/heavy-watch"

const startTask = async (fixture: Fixture, home: string = fixture.home): Promise<OrcResult> => {
  await mkdir(join(home, "backlog", "taken"), { recursive: true })
  const taskFile = join(home, "backlog", "taken", "task-9.md")
  await writeFile(taskFile, ["---", "id: 'task-9'", "title: 'Do the thing'", "project: 'orc'", "machine: null", "depends_on: []", "beat: 'beat-1'", "taken_for: 'linux'", "account: 'main'", "taken_at: '2026-10-27T10:01:00.000Z'", "created: '2026-10-27T10:00:00.000Z'", "---", "# Do the thing", ""].join("\n"))
  return runOrc(fixture, ["runner", "start"], {
    ORC_HOME: home,
    ORC_TASK_ID: "task-9",
    ORC_TASK_FILE: taskFile,
    ORC_TASK_CHECKOUT: fixture.checkout,
    ORC_TASK_PROVIDER: "acme",
    ORC_TASK_TOKEN_FILE: mainToken
  })
}

const linesOf = async (file: string): Promise<ReadonlyArray<string> | null> =>
  readFile(file, "utf8").then((text) => text.split("\n").slice(0, -1), () => null)

const streamGroup = async (fixture: Fixture): Promise<string> => {
  const [, , group = ""] = (await linesOf(join(fixture.pueue, "alerts-group-args"))) ?? []
  return group
}

const writeStream = (fixture: Fixture, group: string, status: unknown): Promise<void> =>
  writeFile(join(fixture.pueue, "status.json"), JSON.stringify({
    tasks: { "900": { id: 900, label: fixture.home + " alerts", group, path: fixture.home, status } },
    groups: {}
  }))

describe("the alert stream orc runner start queues", () => {
  test("a start queues the stream in a group of its own that runs one task, appending to the backlog's alerts.jsonl", async () => {
    await withFixture(async (fixture) => {
      const started = await startTask(fixture)
      expect(started.exitCode).toBe(0)
      const group = await streamGroup(fixture)
      expect(group).toMatch(/^orc-alerts-[0-9a-f]{12}$/)
      expect(await linesOf(join(fixture.pueue, "alerts-group-args"))).toEqual(["group", "add", group, "--parallel", "1"])
      expect(await linesOf(join(fixture.pueue, "alerts-add-args"))).toEqual([
        "add", "--group", group, "--label", fixture.home + " alerts", "--working-directory", fixture.home, "--print-task-id", "--escape", "--",
        "sh", "-c", "out=$1; shift; exec \"$@\" >> \"$out\"", "orc-alerts", join(fixture.home, "backlog", "alerts.jsonl"),
        join(fixture.dir, "bin", "orc-dash"), "alerts", "--json"
      ])
      expect(started.stdout).toBe(
        "queued task-9 as pueue task 77 in group orc\n" +
          "queued the alert stream as pueue task 900 in group " + group + ", its fires to " + join(fixture.home, "backlog", "alerts.jsonl") + "\n" +
          "queued the heavy watch as pueue task 78 in group " + watchGroup(fixture.home) + "\n"
      )
    })
  }, runnerTimeout)

  test("a start while the stream runs queues no second stream instead of one per task", async () => {
    await withFixture(async (fixture) => {
      await startTask(fixture)
      const group = await streamGroup(fixture)
      await writeStream(fixture, group, { Running: { start: "2026-10-27T10:00:00.000Z" } })
      await Bun.write(join(fixture.pueue, "alerts-add-args"), "")
      const again = await startTask(fixture)
      expect(again.stdout).toBe("queued task-9 as pueue task 79 in group orc\n")
      expect(await readFile(join(fixture.pueue, "alerts-add-args"), "utf8")).toBe("")
    })
  }, runnerTimeout)

  test("a start after the stream ended queues it again instead of leaving the chat without alerts", async () => {
    await withFixture(async (fixture) => {
      await startTask(fixture)
      const group = await streamGroup(fixture)
      await writeStream(fixture, group, { Done: { start: "2026-10-27T10:00:00.000Z", end: "2026-10-27T10:05:00.000Z", result: { Failed: 1 } } })
      expect((await startTask(fixture)).stdout).toContain("queued the alert stream as pueue task 900 in group " + group)
    })
  }, runnerTimeout)

  test("another home gets a stream group of its own instead of waiting behind this home's stream", async () => {
    await withFixture(async (fixture) => {
      await startTask(fixture)
      const first = await streamGroup(fixture)
      const other = join(fixture.dir, "other-home")
      await startTask(fixture, other)
      expect(await streamGroup(fixture)).not.toBe(first)
    })
  }, runnerTimeout)

  test("a stream pueue refuses fails no task and says so on stderr instead of failing the start", async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.pueue, "fail-alerts"), "")
      const started = await startTask(fixture)
      expect(started.exitCode).toBe(0)
      expect(started.stdout).toBe(
        "queued task-9 as pueue task 77 in group orc\n" +
          "queued the heavy watch as pueue task 78 in group " + watchGroup(fixture.home) + "\n"
      )
      expect(started.stderr).toBe("orc runner start queued no alert stream: pueue group exited 1: fake pueue refuses the alert stream\n")
    })
  }, runnerTimeout)
})
