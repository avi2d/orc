import { describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
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
        label: fixture.home + " orc-1",
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
      branch: "orc/orc-1",
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

const askWhileRunning = async (fixture: Fixture): Promise<string> => {
  await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({
    tasks: {
      "77": { id: 77, label: fixture.home + " orc-1", group: "orc", path: fixture.checkout, status: { Running: { start: "2026-11-02T10:00:00Z" } } }
    },
    groups: {}
  }))
  const db = await Effect.runPromise(openDatabase(fixture.home).pipe(Effect.provide(BunServices.layer)))
  try {
    Effect.runSync(recordRun(db, {
      id: "run-1",
      project: fixture.checkout,
      branch: "orc/orc-1",
      taskFile: "task.md",
      status: "running",
      started: "2026-11-02T10:00:05.000Z",
      ended: null,
      prLink: null
    }))
  } finally {
    db.close()
  }
  const runDir = join(fixture.home, "runs", "run-1")
  await mkdir(runDir, { recursive: true })
  await writeFile(join(runDir, "asking.json"), JSON.stringify({ until: "2026-11-02T10:50:00.000Z", questions: [{ id: "r2", text: "Keep the old flag?" }] }))
  return runDir
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
      expect(parked).toContain("parked orc-1 on orc/orc-1 for the captain's answer to question-4, question-5")
      expect(parked).not.toContain("closed orc-1")
      expect(await backlogTaskOne(fixture)).toMatchObject({
        id: "orc-1",
        status: "new",
        parked: {
          branch: "orc/orc-1",
          questions: [{ id: "question-4", text: "Which retries are allowed?", answer: null }, { id: "question-5", text: "", answer: null }]
        }
      })
      expect(await orcOk(fixture, ["beat"])).toContain("waits orc-1: parked on orc/orc-1 for the captain's answer to question-4, question-5")
      expect(await queuedSince(fixture)).toBeNull()
    })
  }, runnerTimeout)

  test("a partial answer keeps the rest parked, and the full answer resumes the same branch with every --answer instead of a fresh run", async () => {
    await withFixture(async (fixture) => {
      await startOnLinux(fixture)
      await refuseOnQuestions(fixture)
      await orcOk(fixture, ["beat"])
      expect(await orcOk(fixture, ["backlog", "answer", "orc-1", "question-4=Two retries, then stop"])).toBe("answered question-4 on orc-1, and it stays parked for question-5\n")
      expect(await orcOk(fixture, ["beat"])).toContain("waits orc-1: parked on orc/orc-1 for the captain's answer to question-5")
      expect(await queuedSince(fixture)).toBeNull()
      expect(await orcOk(fixture, ["backlog", "answer", "orc-1", "question-5=Only", "the", "wide", "scope"])).toBe("answered question-5 on orc-1, so the beat resumes it on orc/orc-1\n")
      expect(await orcOk(fixture, ["beat"])).toContain("started orc-1")
      const added = await queuedArgs(fixture)
      expect(added?.slice(added.indexOf("--branch"))).toEqual([
        "--branch", "orc/orc-1", "--sandbox", "none", "--provider", "acme",
        "--answer", "question-4=Two retries, then stop", "--answer", "question-5=Only the wide scope",
        "--token-file", mainToken
      ])
    })
  }, runnerTimeout)

  test("a run waiting at its gate gets the captain's answer from the next beat instead of parking for a new dispatch", async () => {
    await withFixture(async (fixture) => {
      await startOnLinux(fixture)
      const runDir = await askWhileRunning(fixture)
      expect(await orcOk(fixture, ["beat"])).toContain("asking orc-1 on linux: the run waits until 2026-11-02T10:50:00.000Z for the captain's answer to r2")
      expect(await backlogTaskOne(fixture)).toMatchObject({ id: "orc-1", status: "started", parked: { branch: "orc/orc-1", questions: [{ id: "r2", text: "Keep the old flag?", answer: null }] } })
      expect(await orcOk(fixture, ["backlog"])).toContain("orc-1 orc on linux started asking (r2)")
      expect(await orcOk(fixture, ["backlog", "answer", "orc-1", "r2=Keep", "it", "behind", "a", "flag"])).toBe("answered r2 on orc-1, so the next beat hands it to the run waiting on orc/orc-1\n")
      const relayed = await orcOk(fixture, ["beat"])
      expect(relayed).toContain("handed r2 to the run of orc-1 on linux")
      expect(relayed).not.toContain("parked orc-1")
      expect(JSON.parse(await readFile(join(runDir, "answers.json"), "utf8"))).toEqual([{ question: "r2", answer: "Keep it behind a flag" }])
      expect(await backlogTaskOne(fixture)).toMatchObject({ id: "orc-1", status: "started" })
      expect(await queuedSince(fixture)).toBeNull()
    })
  }, runnerTimeout)

  test("a question asked again after its answer was handed out asks anew instead of handing the old answer again", async () => {
    await withFixture(async (fixture) => {
      await startOnLinux(fixture)
      const runDir = await askWhileRunning(fixture)
      await orcOk(fixture, ["beat"])
      await orcOk(fixture, ["backlog", "answer", "orc-1", "r2=Keep", "it"])
      expect(await orcOk(fixture, ["beat"])).toContain("handed r2 to the run of orc-1 on linux")
      await writeFile(join(runDir, "asking.json"), JSON.stringify({ until: "2026-11-02T11:50:00.000Z", questions: [{ id: "r2", text: "Keep the old flag?" }] }))
      const reasked = await orcOk(fixture, ["beat"])
      expect(reasked).toContain("asking orc-1 on linux")
      expect(reasked).not.toContain("handed r2")
      expect(await orcOk(fixture, ["backlog", "answer", "orc-1", "r2=Restore", "it"])).toBe("answered r2 on orc-1, so the next beat hands it to the run waiting on orc/orc-1\n")
      const relayed = await orcOk(fixture, ["beat"])
      expect(relayed).toContain("handed r2 to the run of orc-1 on linux")
      expect(JSON.parse(await readFile(join(runDir, "answers.json"), "utf8"))).toEqual([{ question: "r2", answer: "Restore it" }])
    })
  }, runnerTimeout)

  test("an answer given as the wait ran out resumes the run with it instead of parking it unanswered", async () => {
    await withFixture(async (fixture) => {
      await startOnLinux(fixture)
      await askWhileRunning(fixture)
      await orcOk(fixture, ["beat"])
      await orcOk(fixture, ["backlog", "answer", "orc-1", "r2=Yes"])
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({
        tasks: {
          "77": { id: 77, label: fixture.home + " orc-1", group: "orc", path: fixture.checkout, status: { Done: { start: "2026-11-02T10:00:00Z", end: "2026-11-02T10:55:00Z", result: { Failed: 1 } } } }
        },
        groups: {}
      }))
      const db = await Effect.runPromise(openDatabase(fixture.home).pipe(Effect.provide(BunServices.layer)))
      try {
        db.run("update runs set status = 'failed', ended = '2026-11-02T10:54:00.000Z' where id = 'run-1'")
        const step = insertStep(db, { runId: "run-1", name: "no-mistakes", attempt: 1, status: "failed", started: "2026-11-02T10:20:00.000Z", ended: "2026-11-02T10:54:00.000Z", agentFile: null, piSessionFile: null })
        insertSignal(db, { stepId: step, name: "open-question", value: JSON.stringify({ id: "r2", text: "Keep the old flag?" }) })
      } finally {
        db.close()
      }
      const beat = await orcOk(fixture, ["beat"])
      expect(beat).toContain("parked orc-1 on orc/orc-1 for the captain's answer to r2")
      expect(beat).toContain("started orc-1")
      const added = await queuedArgs(fixture)
      expect(added?.slice(added.indexOf("--answer"), added.indexOf("--answer") + 2)).toEqual(["--answer", "r2=Yes"])
    })
  }, runnerTimeout)

  test("an answer that names no parked question is refused instead of recorded", async () => {
    await withFixture(async (fixture) => {
      await startOnLinux(fixture)
      await refuseOnQuestions(fixture)
      await orcOk(fixture, ["beat"])
      const refused = await runOrc(fixture, ["backlog", "answer", "orc-1", "question-9=Yes"])
      expect(refused.exitCode).not.toBe(0)
      expect(refused.stderr).toContain("orc-1 is parked for the captain's answer to question-4, question-5, so answer one as <question-id>=<text>")
    })
  }, runnerTimeout)
})
