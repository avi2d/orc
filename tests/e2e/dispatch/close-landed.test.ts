import { expect, test } from "bun:test"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type Fixture, orcOk, runOrc, runnerTimeout, withFixture } from "../runner-helpers"

const at = "2026-01-01T00:00:00.000Z"
const mergedPr = "https://github.com/example/project/pull/42"
const originalPr = "https://github.com/example/project/pull/19"

const backlog = (fixture: Fixture, ...parts: ReadonlyArray<string>): string => join(fixture.home, "backlog", ...parts)

const task = async (fixture: Fixture, id: string, fields: Readonly<Record<string, unknown>>, folder: "new" | "taken" = "new"): Promise<void> => {
  const frontmatter = { id, title: id, project: "orc", machine: null, created: at, depends_on: [], ...fields }
  await Promise.all([folder, "closed"].map((name) => mkdir(backlog(fixture, name), { recursive: true })))
  await writeFile(backlog(fixture, folder, id + ".md"), [
    "---",
    ...Object.entries(frontmatter).map(([key, value]) => key + ": " + JSON.stringify(value)),
    "---",
    "# " + id,
    ""
  ].join("\n"))
}

const parked = {
  parked_branch: "orc/parked",
  parked_at: at,
  parked_origin: { machine: "runner", run: "saved-run", pr: originalPr },
  parked_questions: [
    { id: "r1", text: "Keep the output name?", asked_at: at, owner: "user" },
    { id: "r2", text: "Keep the old flag?", asked_at: at, answer: "Keep it", answered_at: at }
  ]
}

const openItem = async (fixture: Fixture, taskId: string, kind: "pr-ready" | "review-question" | "check-red"): Promise<string> => {
  await mkdir(backlog(fixture, "attention"), { recursive: true })
  const file = backlog(fixture, "attention", taskId + "." + kind + ".record.json")
  await writeFile(file, JSON.stringify({ task: taskId, kind, text: "Waiting on a choice", asked: at, owner: "user", state: { kind: "open" } }))
  return file
}

const forbidForgeCommands = async (fixture: Fixture): Promise<string> => {
  const touchedForge = join(fixture.dir, "forge-called")
  for (const command of ["git", "gh", "gh-axi"]) {
    const file = join(fixture.dir, "bin", command)
    await writeFile(file, '#!/bin/sh\ntouch "$ORC_HOME/../forge-called"\nexit 1\n')
    await chmod(file, 0o755)
  }
  return touchedForge
}

const markLanded = (fixture: Fixture, id: string) => orcOk(fixture, ["backlog", "close", id, "--landed-in", mergedPr])

const attention = async (fixture: Fixture): Promise<unknown> => JSON.parse(await orcOk(fixture, ["attention", "--json"]))

test("a parked child closed as landed stays visible as done with its landing PR without touching its branch", async () => {
  await withFixture(async (fixture) => {
    await task(fixture, "orc-1", { kind: "parent" })
    await task(fixture, "orc-2", { parent: "orc-1", ...parked })
    const question = await openItem(fixture, "orc-2", "review-question")
    const green = await openItem(fixture, "orc-2", "pr-ready")
    const red = await openItem(fixture, "orc-2", "check-red")
    await openItem(fixture, "orc-1", "review-question")
    const touchedForge = await forbidForgeCommands(fixture)

    expect(await orcOk(fixture, ["backlog", "plan", "orc-1"])).toContain("0 of 1 done")
    expect(await markLanded(fixture, "orc-2")).toBe("closed orc-2 done: work landed in " + mergedPr + "\n")
    const plan = await orcOk(fixture, ["backlog", "plan", "orc-1"])
    expect(plan).toContain("1 of 1 done")
    expect(plan).toContain("orc-2 done landed in " + mergedPr + " orc-2")
    expect(await Bun.file(backlog(fixture, "new", "orc-2.md")).exists()).toBe(false)
    const board: unknown = JSON.parse(await orcOk(fixture, ["backlog", "--json"]))
    expect(board).toMatchObject({ tasks: expect.arrayContaining([
      expect.objectContaining({
        id: "orc-2", status: "closed", outcome: "done", reason: "work landed in " + mergedPr, landedIn: mergedPr, pr: null,
        parked: expect.objectContaining({ questions: [expect.objectContaining({ id: "r2", answer: { words: "Keep it", at, decider: "owner" } })] })
      })
    ]) })
    expect(await attention(fixture)).toMatchObject({ items: [expect.objectContaining({ task: "orc-1" })] })
    for (const file of [question, green, red]) {
      const stored: unknown = JSON.parse(await readFile(file, "utf8"))
      expect(stored).toMatchObject({ state: { kind: "withdrawn", reason: "task closed" } })
    }
    expect(await Bun.file(touchedForge).exists()).toBe(false)
  })
}, runnerTimeout)

test("an externally completed parked prerequisite releases a ship task without deleting its dependency", async () => {
  await withFixture(async (fixture) => {
    await task(fixture, "orc-1", parked)
    await task(fixture, "orc-2", { priority: 0, depends_on: ["orc-1"] })
    const board = async (): Promise<unknown> => JSON.parse(await orcOk(fixture, ["backlog", "--json"]))
    expect(await board()).toMatchObject({ tasks: expect.arrayContaining([
      expect.objectContaining({ id: "orc-2", waiting: expect.objectContaining({ kind: "depends", detail: "waits on orc-1" }) })
    ]) })
    await markLanded(fixture, "orc-1")
    expect(await board()).toMatchObject({ tasks: expect.arrayContaining([
      expect.objectContaining({ id: "orc-2", dependsOn: ["orc-1"], wait: null, waiting: expect.objectContaining({ kind: "room" }) })
    ]) })
  })
}, runnerTimeout)

test("close --landed-in refuses an unparked task and a link that is not a PR", async () => {
  await withFixture(async (fixture) => {
    await task(fixture, "orc-1", {})
    await task(fixture, "orc-2", parked)
    const unparked = await runOrc(fixture, ["backlog", "close", "orc-1", "--landed-in", mergedPr])
    expect(unparked.exitCode).toBe(1)
    expect(unparked.stderr).toContain("orc-1 is not a parked task")
    const badLink = await runOrc(fixture, ["backlog", "close", "orc-2", "--landed-in", "https://github.com/example/project/issues/42"])
    expect(badLink.exitCode).toBe(1)
    expect(badLink.stderr).toContain("takes the full URL of the merged PR")
    expect(await Bun.file(backlog(fixture, "new", "orc-1.md")).exists()).toBe(true)
    expect(await Bun.file(backlog(fixture, "new", "orc-2.md")).exists()).toBe(true)
  })
}, runnerTimeout)

test("manual close and drop withdraw pr-ready items instead of leaving merge requests in attention", async () => {
  await withFixture(async (fixture) => {
    await task(fixture, "orc-1", parked)
    await task(fixture, "orc-2", { beat: "beat-example", taken_for: "runner", account: "main", taken_at: at, started_at: at }, "taken")
    const dropped = await openItem(fixture, "orc-1", "pr-ready")
    const closed = await openItem(fixture, "orc-2", "pr-ready")
    expect(await attention(fixture)).toMatchObject({ items: [expect.anything(), expect.anything()] })
    await orcOk(fixture, ["backlog", "drop", "orc-1", "no longer needed"])
    await orcOk(fixture, ["backlog", "close", "orc-2", "failed", "work did not finish"])
    expect(await attention(fixture)).toMatchObject({ items: [] })
    for (const file of [dropped, closed]) {
      const stored: unknown = JSON.parse(await readFile(file, "utf8"))
      expect(stored).toMatchObject({ state: { kind: "withdrawn", reason: "task closed" } })
    }
  })
}, runnerTimeout)
