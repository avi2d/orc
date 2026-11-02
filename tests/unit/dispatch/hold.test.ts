import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Result } from "effect"
import { parseTaskFile, renderTaskFile, type TaskRecord } from "../../../packages/run/src/dispatch/task-record"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const spec = { title: "Fix the thing", project: "orc", machine: null, dependsOn: [], created: "2026-10-27T10:00:00.000Z", body: "# Fix the thing\n" }

describe("held task files", () => {
  test("a held and answered task survives a write and a read with its words intact instead of losing the hold", async () => {
    const record: TaskRecord = {
      spec: { ...spec, id: "task-4", body: "# Fix the thing\n" },
      hold: { reason: "which API: REST or \"gRPC\"?", until: "2026-12-01", answer: { words: "REST,\n  and keep v1 — for now", at: "2026-11-02T12:00:00.000Z" } },
      state: { kind: "new" }
    }
    expect(await run(parseTaskFile("task-4.md", "new", renderTaskFile(record)))).toEqual(record)
  })
  const holdRefusal = async (folder: "new" | "taken" | "closed", lines: ReadonlyArray<string>): Promise<string> => {
    const text = ["---", "id: task-5", "title: Fix the thing", "project: orc", "machine: null", "depends_on: []", "created: 2026-10-27T10:00:00.000Z", ...lines, "---", "# Fix the thing", ""].join("\n")
    const result = await run(Effect.result(parseTaskFile("task-5.md", folder, text)))
    return Result.isFailure(result) ? result.failure.detail : "read as held " + JSON.stringify(Result.isSuccess(result) ? result.success.hold : null)
  }
  test("a malformed hold is refused instead of read as an unheld task", async () => {
    expect(await holdRefusal("new", ["hold_until: \"2026-12-01\""])).toBe("a hold names no reason")
    expect(await holdRefusal("new", ["hold_reason: \"\""])).toBe("a hold names no reason")
    expect(await holdRefusal("new", ["hold_reason: 3"])).toContain("hold_reason")
    expect(await holdRefusal("new", ["hold_reason: \"why\"", "hold_until: \"next week\""])).toBe("the hold_until next week is no YYYY-MM-DD date")
    expect(await holdRefusal("new", ["hold_reason: \"why\"", "hold_until: \"2026-02-30\""])).toBe("the hold_until 2026-02-30 is no YYYY-MM-DD date")
    expect(await holdRefusal("new", ["hold_reason: \"why\"", "answer: \"yes\""])).toBe("an answer names no words or no time")
    expect(await holdRefusal("new", ["hold_reason: \"why\"", "answered_at: \"2026-11-02T12:00:00.000Z\""])).toBe("an answer names no words or no time")
    expect(await holdRefusal("new", ["answer: \"yes\"", "answered_at: \"2026-11-02T12:00:00.000Z\""])).toBe("a hold names no reason")
  })
  test("a started or closed task with an unanswered hold is refused instead of read as running", async () => {
    const claimLines = ["beat: beat-1", "taken_for: mac", "account: main", "taken_at: 2026-10-27T10:01:00.000Z", "started_at: 2026-10-27T10:02:00.000Z", "start_log: /tmp/l"]
    expect(await holdRefusal("taken", ["hold_reason: \"why\"", ...claimLines])).toBe("a started task carries an unanswered hold")
    expect(await holdRefusal("closed", ["hold_reason: \"why\"", ...claimLines, "outcome: done", "closed_at: 2026-10-27T11:00:00.000Z"])).toBe("a closed task carries an unanswered hold")
  })
})
