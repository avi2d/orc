import { describe, expect, test } from "bun:test"
import { rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { insertSignal, insertStep, openDatabase, recordRun } from "../../packages/run/src/entities/run-history/index"
import { binPath, fakeQuota, mainToken, orcOk, queuedArgs, runnerTimeout, withFixture, type Fixture } from "./runner-helpers"

describe("an ask-user finding parks as a question", () => {
  test("an unanswered ask-user finding parks with its text and resumes with its answer instead of closing failed", async () => {
    await withFixture(async (fixture: Fixture) => {
      await fakeQuota(fixture)
      await writeFile(join(fixture.home, "backlog", "dispatch.json"), JSON.stringify({
        machines: [{ name: "linux", slots: 1, start: [process.execPath, binPath, "runner", "start"] }],
        quota: { provider: "acme", command: ["orc-quota"], accounts: [{ name: "main", tokenFile: mainToken }], floorPercent: 15 }
      }))
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
      await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--machine", "linux"])
      await orcOk(fixture, ["beat"])
      await rm(join(fixture.pueue, "add-args"), { force: true })
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
        insertSignal(db, { stepId: step, name: "open-question", value: JSON.stringify({ id: "r2", text: "changes product behavior" }) })
      } finally {
        db.close()
      }
      const parked = await orcOk(fixture, ["beat"])
      expect(parked).toContain("parked orc-1 on orc/orc-1 for the captain's answer to r2")
      expect(parked).not.toContain("closed orc-1")
      const backlog: unknown = JSON.parse(await orcOk(fixture, ["backlog", "--json"]))
      const task = typeof backlog === "object" && backlog !== null && "tasks" in backlog && Array.isArray(backlog.tasks) ? backlog.tasks[0] : null
      expect(task).toMatchObject({
        id: "orc-1",
        status: "new",
        parked: { branch: "orc/orc-1", questions: [{ id: "r2", text: "changes product behavior", answer: null }] }
      })
      expect(await orcOk(fixture, ["backlog", "answer", "orc-1", "r2=Keep the flag"])).toBe("answered r2 on orc-1, so the beat resumes it on orc/orc-1\n")
      await rm(join(fixture.pueue, "add-args"), { force: true })
      expect(await orcOk(fixture, ["beat"])).toContain("started orc-1")
      const added = await queuedArgs(fixture)
      expect(added?.slice(added.indexOf("--answer"), added.indexOf("--answer") + 2)).toEqual(["--answer", "r2=Keep the flag"])
    })
  }, runnerTimeout)
})
