import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Array as Arr, Effect, Result } from "effect"
import { addTask, claimTask, listTasks, writeTaken, parseTaskFile, type TaskRecord, renderTaskFile } from "../../../packages/run/src/entities/backlog/index"
import { holdTask } from "../../../packages/run/src/features/backlog-planning/backlog-hold"
import { parkStartedTask } from "../../../packages/run/src/entities/parked-runs/index"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const spec = { title: "Fix the thing", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0 as const, created: "2026-10-27T10:00:00.000Z", body: "# Fix the thing\n" }

describe("held task files", () => {
  test("a held and answered task survives a write and a read with its words intact instead of losing the hold", async () => {
    const record: TaskRecord = {
      spec: { ...spec, id: "task-4", body: "# Fix the thing\n" },
      hold: { reason: "which API: REST or \"gRPC\"?", until: "2026-12-01", questions: [], answer: { words: "REST,\n  and keep v1 — for now", at: "2026-11-02T12:00:00.000Z" }, at: "2026-11-01T09:00:00.000Z" },
      parked: null,
      state: { kind: "new" }
    }
    expect(await run(parseTaskFile("task-4.md", "new", renderTaskFile(record)))).toEqual(record)
  })
  test("a hold with one of two questions answered survives a write and a read instead of dropping the open question", async () => {
    const record: TaskRecord = {
      spec: { ...spec, id: "task-4", body: "# Fix the thing\n" },
      hold: {
        reason: "two choices",
        until: null,
        questions: [
          { id: "question-1", text: "REST or \"gRPC\"?", answer: { words: "gRPC, for now", at: "2026-11-02T12:00:00.000Z" } },
          { id: "question-2", text: "Which region?", answer: null }
        ],
        answer: null,
        at: null
      },
      parked: null,
      state: { kind: "new" }
    }
    expect(await run(parseTaskFile("task-4.md", "new", renderTaskFile(record)))).toEqual(record)
  })
  test("a new hold carries the time it was placed instead of no time", async () => {
    const root = await mkdtemp(join(tmpdir(), "orc-hold-at-"))
    try {
      await run(addTask(root, spec))
      const before = Date.now()
      const outcome = await run(holdTask(root, "orc-1", { reason: "wait for budget", until: null, questions: [] }))
      const at = Date.parse(outcome.hold.at ?? "")
      expect(at >= before && at <= Date.now()).toBe(true)
      expect((await run(listTasks(root)))[0]?.hold?.at).toBe(outcome.hold.at)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test("the first hold keeps its time in hold_history after a second hold instead of losing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "orc-hold-history-at-"))
    try {
      await run(addTask(root, spec))
      const first = await run(holdTask(root, "orc-1", { reason: "wait for budget", until: null, questions: [] }))
      const file = join(root, "new", "orc-1.md")
      const answered = (await readFile(file, "utf8")).replace("\n---\n", "\nanswer: \"approved\"\nanswered_at: \"2026-11-02T12:00:00.000Z\"\n---\n")
      await Bun.write(file, answered)
      const second = await run(holdTask(root, "orc-1", { reason: "wait for the merge", until: null, questions: [] }))
      expect(second.hold.history?.map((entry) => entry.at)).toEqual([first.hold.at ?? ""])
      expect((await run(listTasks(root)))[0]?.hold?.history?.[0]?.at).toBe(first.hold.at ?? "")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test("a hold written with no held_at still parses with a null time instead of being refused", async () => {
    const text = ["---", "id: task-6", "title: Fix the thing", "project: orc", "machine: null", "depends_on: []", "created: 2026-10-27T10:00:00.000Z", "hold_reason: wait for budget", "---", "# Fix the thing", ""].join("\n")
    expect((await run(parseTaskFile("task-6.md", "new", text))).hold?.at).toBeNull()
  })
  test("asking a held task the same questions again keeps it, and asking others is refused instead of replacing the open ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "orc-hold-questions-"))
    try {
      await run(addTask(root, spec))
      const ask = { reason: "two choices", until: null, questions: ["REST or gRPC?", "Which region?"] }
      expect((await run(holdTask(root, "orc-1", ask))).kind).toBe("held")
      const file = join(root, "new", "orc-1.md")
      const before = await readFile(file, "utf8")
      expect((await run(holdTask(root, "orc-1", ask))).kind).toBe("already held")
      const failure = await run(Effect.flip(holdTask(root, "orc-1", { ...ask, questions: ["Which database?"] })))
      expect(failure.detail).toBe("orc-1 is already held on question-1, question-2, so answer those first")
      expect(await readFile(file, "utf8")).toBe(before)
      expect((await run(listTasks(root)))[0]?.hold?.questions.map((question) => question.id + " " + question.text)).toEqual(["question-1 REST or gRPC?", "question-2 Which region?"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test("holding a reason-only held task again with questions is refused instead of attaching them", async () => {
    const root = await mkdtemp(join(tmpdir(), "orc-hold-reason-"))
    try {
      await run(addTask(root, spec))
      await run(holdTask(root, "orc-1", { reason: "wait for budget", until: null, questions: [] }))
      const file = join(root, "new", "orc-1.md")
      const before = await readFile(file, "utf8")
      const failure = await run(Effect.flip(holdTask(root, "orc-1", { reason: "wait for budget", until: null, questions: ["Which API?"] })))
      expect(failure.detail).toBe("orc-1 is already held: wait for budget, so answer it first")
      expect(await readFile(file, "utf8")).toBe(before)
      expect((await run(holdTask(root, "orc-1", { reason: "wait for budget", until: null, questions: [] }))).kind).toBe("already held")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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
    expect(await holdRefusal("new", ["hold_reason: \"why\"", "hold_questions: [{\"id\":\"question-1\",\"text\":\"REST?\",\"answer\":\"yes\",\"answered_at\":\"2026-11-02T12:00:00.000Z\"}]"]))
      .toBe("a hold answers every question and names no answer")
    expect(await holdRefusal("new", ["hold_reason: \"why\"", "hold_questions: [{\"id\":\"question-1\",\"text\":\"REST?\",\"answer\":\"yes\"}]"]))
      .toBe("the held question question-1 names its answer with no words or no time")
  })
  test("a hold on a parked task is refused instead of written", async () => {
    const root = await mkdtemp(join(tmpdir(), "orc-hold-parked-"))
    try {
      const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-10-27T10:01:00.000Z" }
      await run(addTask(root, spec))
      await run(claimTask(root, "orc-1"))
      await run(writeTaken(root, { spec: { ...spec, id: "orc-1", body: "# Fix the thing\n" }, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-10-27T10:02:00.000Z", log: root + "/logs/orc-1.log" } } }))
      await run(parkStartedTask(root, "orc-1", "orc/orc-1", Arr.make({ id: "question-4", text: "Which retries are allowed?" }), "2026-10-27T10:30:00.000Z"))
      const file = join(root, "new", "orc-1.md")
      const before = await readFile(file, "utf8")
      const failure = await run(Effect.flip(holdTask(root, "orc-1", { reason: "wait for budget", until: null, questions: [] })))
      expect(failure.detail).toBe("orc-1 is parked for the captain's answer, so it cannot be held")
      expect(await readFile(file, "utf8")).toBe(before)
      expect((await run(listTasks(root)))[0]?.hold).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test("a started or closed task with an unanswered hold is refused instead of read as running", async () => {
    const claimLines = ["beat: beat-1", "taken_for: mac", "account: main", "taken_at: 2026-10-27T10:01:00.000Z", "started_at: 2026-10-27T10:02:00.000Z", "start_log: /tmp/l"]
    expect(await holdRefusal("taken", ["hold_reason: \"why\"", ...claimLines])).toBe("a started task carries an unanswered hold")
    expect(await holdRefusal("closed", ["hold_reason: \"why\"", ...claimLines, "outcome: done", "closed_at: 2026-10-27T11:00:00.000Z"])).toBe("a closed task carries an unanswered hold")
  })
})
