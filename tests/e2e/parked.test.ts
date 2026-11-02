import { describe, expect, test } from "bun:test"
import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { insertSignal, insertStep, openDatabase, recordRun } from "../../packages/run/src/run-history"
import { binPath, fakeQuota, type Fixture, mainToken, orcOk, queuedArgs, runnerTimeout, runOrc, withFixture } from "./runner-helpers"

const startOnLinux = async (fixture: Fixture): Promise<void> => {
  await fakeQuota(fixture)
  await writeFile(join(fixture.home, "backlog", "dispatch.json"), JSON.stringify({
    machines: [{ name: "linux", slots: 1, start: [process.execPath, binPath, "runner", "start"] }],
    quota: { provider: "acme", command: ["orc-quota"], accounts: [{ name: "main", tokenFile: mainToken }], floorPercent: 15 }
  }))
  await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
  await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--machine", "linux"])
  await orcOk(fixture, ["beat"])
  expect(await queuedArgs(fixture)).not.toBeNull()
  await rm(join(fixture.pueue, "add-args"))
}

const refuseOnQuestions = async (fixture: Fixture): Promise<void> => {
  await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({
    tasks: {
      "77": {
        id: 77,
        label: fixture.home + " task-1",
        group: "orc",
        path: fixture.checkout,
        status: { Done: { start: "2026-11-02T10:00:00Z", end: "2026-11-02T10:30:00Z", result: { Failed: 1 } } }
      }
    },
    groups: {}
  }))
  const db = await Effect.runPromise(openDatabase(fixture.home).pipe(Effect.provide(BunServices.layer)))
  try {
    Effect.runSync(recordRun(db, {
      id: "run-1",
      project: fixture.checkout,
      branch: "orc/task-1",
      taskFile: "task.md",
      status: "failed",
      started: "2026-11-02T10:00:05.000Z",
      ended: "2026-11-02T10:29:00.000Z",
      prLink: null
    }))
    const step = insertStep(db, { runId: "run-1", name: "no-mistakes", attempt: 1, status: "failed", started: "2026-11-02T10:20:00.000Z", ended: "2026-11-02T10:29:00.000Z", agentFile: null, piSessionFile: null })
    insertSignal(db, { stepId: step, name: "open-question", value: JSON.stringify({ id: "question-4", text: "Which retries are allowed?" }) })
    insertSignal(db, { stepId: step, name: "open-question", value: JSON.stringify({ id: "question-5", text: "" }) })
  } finally {
    db.close()
  }
}

const queuedSince = (fixture: Fixture): Promise<string | null> => readFile(join(fixture.pueue, "add-args"), "utf8").catch(() => null)

const backlogTaskOne = async (fixture: Fixture): Promise<unknown> => {
  const backlog: unknown = JSON.parse(await orcOk(fixture, ["backlog", "--json"]))
  return typeof backlog === "object" && backlog !== null && "tasks" in backlog && Array.isArray(backlog.tasks) ? backlog.tasks[0] : null
}

describe("a parked run", () => {
  test("a run refused on open questions parks on its branch instead of closing failed or starting again unanswered", async () => {
    await withFixture(async (fixture) => {
      await startOnLinux(fixture)
      await refuseOnQuestions(fixture)
      const parked = await orcOk(fixture, ["beat"])
      expect(parked).toContain("parked task-1 on orc/task-1 for the captain's answer to question-4, question-5")
      expect(parked).not.toContain("closed task-1")
      expect(await backlogTaskOne(fixture)).toMatchObject({
        id: "task-1",
        status: "new",
        parked: {
          branch: "orc/task-1",
          questions: [{ id: "question-4", text: "Which retries are allowed?", answer: null }, { id: "question-5", text: "", answer: null }]
        }
      })
      expect(await orcOk(fixture, ["beat"])).toContain("waits task-1: parked on orc/task-1 for the captain's answer to question-4, question-5")
      expect(await queuedSince(fixture)).toBeNull()
    })
  }, runnerTimeout)

  test("a partial answer keeps the rest parked, and the full answer resumes the same branch with every --answer instead of a fresh run", async () => {
    await withFixture(async (fixture) => {
      await startOnLinux(fixture)
      await refuseOnQuestions(fixture)
      await orcOk(fixture, ["beat"])
      expect(await orcOk(fixture, ["backlog", "answer", "task-1", "question-4=Two retries, then stop"])).toBe("answered question-4 on task-1, and it stays parked for question-5\n")
      expect(await orcOk(fixture, ["beat"])).toContain("waits task-1: parked on orc/task-1 for the captain's answer to question-5")
      expect(await queuedSince(fixture)).toBeNull()
      expect(await orcOk(fixture, ["backlog", "answer", "task-1", "question-5=Only", "the", "wide", "scope"])).toBe("answered question-5 on task-1, so the beat resumes it on orc/task-1\n")
      expect(await orcOk(fixture, ["beat"])).toContain("started task-1")
      const added = await queuedArgs(fixture)
      expect(added?.slice(added.indexOf("--branch"))).toEqual([
        "--branch", "orc/task-1", "--sandbox", "none", "--provider", "acme",
        "--answer", "question-4=Two retries, then stop", "--answer", "question-5=Only the wide scope",
        "--token-file", mainToken
      ])
    })
  }, runnerTimeout)

  test("an answer that names no parked question is refused instead of recorded", async () => {
    await withFixture(async (fixture) => {
      await startOnLinux(fixture)
      await refuseOnQuestions(fixture)
      await orcOk(fixture, ["beat"])
      const refused = await runOrc(fixture, ["backlog", "answer", "task-1", "question-9=Yes"])
      expect(refused.exitCode).not.toBe(0)
      expect(refused.stderr).toContain("task-1 is parked for the captain's answer to question-4, question-5, so answer one as <question-id>=<text>")
    })
  }, runnerTimeout)
})
