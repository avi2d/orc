import { expect } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { insertSignal, insertStep, openDatabase, recordRun } from "../../packages/run/src/entities/run-history/index"
import { binPath, fakeQuota, type Fixture, mainToken, orcOk, queuedArgs } from "./runner-helpers"

export const startOnLinux = async (fixture: Fixture): Promise<void> => {
  await fakeQuota(fixture)
  await writeFile(join(fixture.home, "backlog", "dispatch.json"), JSON.stringify({
    machines: [{ name: "linux", slots: 1, start: [process.execPath, binPath, "runner", "start"] }],
    quota: { provider: "acme", command: ["orc-quota"], accounts: [{ name: "main", tokenFile: mainToken }], floorPercent: 15 }
  }))
  await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
  await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--priority", "0", "--machine", "linux"])
  await orcOk(fixture, ["beat"])
  expect(await queuedArgs(fixture)).not.toBeNull()
  await rm(join(fixture.pueue, "add-args"))
}

const reviewQuestions = [{ id: "question-4", text: "Which retries are allowed?" }, { id: "question-5", text: "" }]

export const refuseOnQuestions = async (fixture: Fixture, questions: ReadonlyArray<{ readonly id: string; readonly text: string }> = reviewQuestions, stepName = "no-mistakes"): Promise<void> => {
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
    const step = insertStep(db, { runId: "run-1", name: stepName, attempt: 1, status: "failed", started: "2026-11-02T10:20:00.000Z", ended: "2026-11-02T10:29:00.000Z", agentFile: null, piSessionFile: null })
    for (const question of questions) {
      insertSignal(db, { stepId: step, name: "open-question", value: JSON.stringify(question) })
    }
  } finally {
    db.close()
  }
}

export const firstAsking: { readonly asked: string; readonly until: string; readonly questions: ReadonlyArray<{ readonly id: string; readonly text: string; readonly options?: ReadonlyArray<{ readonly text: string; readonly outcome?: string; readonly picture?: string }>; readonly recommendation?: string }> } = { asked: "2026-11-02T10:20:00.000Z", until: "2026-11-02T10:50:00.000Z", questions: [{ id: "r2", text: "Keep the old flag?" }] }

export const askWhileRunning = async (fixture: Fixture, asking: typeof firstAsking = firstAsking): Promise<string> => {
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
  await writeFile(join(runDir, "asking.json"), JSON.stringify(asking))
  return runDir
}

export const backlogTaskOne = async (fixture: Fixture): Promise<unknown> => {
  const backlog: unknown = JSON.parse(await orcOk(fixture, ["backlog", "--json"]))
  return typeof backlog === "object" && backlog !== null && "tasks" in backlog && Array.isArray(backlog.tasks) ? backlog.tasks[0] : null
}
