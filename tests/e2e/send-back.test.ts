import { describe, expect, test } from "bun:test"
import { chmod, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { closeTask, type Fixture, orchestratorConfig, ranClosing, runOrc, sessionFor, withFixture } from "./chat-helpers"

const prUrl = "https://github.com/acme/orc/pull/8"

const ghCalls = (fixture: Fixture): string => join(fixture.dir, "gh-calls")

const stubGh = async (fixture: Fixture, state: "OPEN" | "CLOSED" | "MERGED"): Promise<void> => {
  const view = JSON.stringify({ state, headRefOid: "0123456789abcdef0123456789abcdef01234567", baseRefName: "main", statusCheckRollup: [] })
  await writeFile(ghCalls(fixture), "")
  await writeFile(join(fixture.dir, "bin", "gh"), [
    "#!/bin/sh",
    "echo \"$*\" >> '" + ghCalls(fixture) + "'",
    "if [ \"$1 $2\" = \"pr view\" ]; then cat <<'J'",
    view,
    "J",
    "exit 0; fi",
    "echo 'unexpected gh call' >&2",
    "exit 1",
    ""
  ].join("\n"))
  await chmod(join(fixture.dir, "bin", "gh"), 0o755)
}

const addTask = async (fixture: Fixture): Promise<void> => {
  expect(await sessionFor(fixture).call("orc_backlog_add", { project: "orc", task: "# Tidy the docs\n" })).toBe("added orc-1 for orc")
}

const backlogFiles = async (fixture: Fixture): Promise<Record<string, ReadonlyArray<string>>> => {
  const folders = ["new", "closed"]
  const listed = await Promise.all(folders.map((folder) => readdir(join(fixture.home, "backlog", folder)).catch(() => [])))
  return Object.fromEntries(folders.map((folder, index) => [folder, listed[index] ?? []]))
}

const refusedSendBack = async (fixture: Fixture, expected: string): Promise<void> => {
  const before = await backlogFiles(fixture)
  const closed = await readFile(join(fixture.home, "backlog", "closed", "orc-1.md"), "utf8").catch(() => null)
  const sent = await runOrc(fixture, ["backlog", "send-back", "orc-1", "rename", "the", "flag"])
  expect(sent.exitCode).toBe(1)
  expect(sent.stderr.trim()).toBe("orc: orc backlog send-back refused: " + expected)
  expect(await backlogFiles(fixture)).toEqual(before)
  expect(await readFile(join(fixture.home, "backlog", "closed", "orc-1.md"), "utf8").catch(() => null)).toBe(closed)
}

describe("orc backlog send-back refuses a task no run can take back", () => {
  test("a task with no PR is refused before gh instead of parked on a branch with nothing to update", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await addTask(fixture)
      await closeTask(fixture, "orc-1", ranClosing("failed", "no change", null))
      await stubGh(fixture, "OPEN")
      await refusedSendBack(fixture, "orc-1 names no pull request to send back")
      expect(await readFile(ghCalls(fixture), "utf8")).toBe("")
    })
  }, 60_000)

  test("a merged PR is refused instead of restarting a run whose push opens a second PR", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await addTask(fixture)
      await closeTask(fixture, "orc-1", ranClosing("done", "", prUrl))
      await stubGh(fixture, "MERGED")
      await refusedSendBack(fixture, prUrl + " is merged, so no run can update it")
    })
  }, 60_000)

  test("a closed PR is refused instead of restarting a run whose push lands on a dead PR", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await addTask(fixture)
      await closeTask(fixture, "orc-1", ranClosing("done", "", prUrl))
      await stubGh(fixture, "CLOSED")
      await refusedSendBack(fixture, prUrl + " is closed, so no run can update it")
    })
  }, 60_000)

  test("a task that is not closed is refused instead of parked over its live state", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await addTask(fixture)
      await stubGh(fixture, "OPEN")
      await refusedSendBack(fixture, "orc-1 is new, and only a closed task goes back")
      expect(await readFile(ghCalls(fixture), "utf8")).toBe("")
    })
  }, 60_000)

  test("send-back without words is refused as usage instead of parking an empty review", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const sent = await runOrc(fixture, ["backlog", "send-back", "orc-1"])
      expect(sent.exitCode).not.toBe(0)
      expect(sent.stderr).toContain("orc backlog send-back takes a task id and the review's words")
    })
  }, 60_000)
})
