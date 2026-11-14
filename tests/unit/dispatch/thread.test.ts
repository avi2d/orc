import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { parseDispatchArgs } from "../../../packages/run/src/app/dispatch-args"
import { reviewQuestionId, routeTaskItems } from "../../../packages/run/src/entities/attention/index"
import { addTask, appendNote, claimTask, closeStartedTask, listTasks, writeTaken, type TaskRecord } from "../../../packages/run/src/entities/backlog/index"
import { answerTask, askStartedTask } from "../../../packages/run/src/entities/parked-runs/index"
import { decideReviewQuestions, DeciderUnheard, type AskDecider } from "../../../packages/run/src/features/decider/index"
import { threadEntries, threadText } from "../../../packages/run/src/features/task-thread/index"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const spec = { id: "orc-1", title: "Retry the upload", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], created: "2026-11-02T10:00:00.000Z", body: "# Retry the upload\nRetry a failed upload twice, then give up.\n" }

const claim = { beat: "beat-1", machine: "linux", account: "main", takenAt: "2026-11-02T10:01:00.000Z" }

const started = { kind: "started" as const, claim, started: { at: "2026-11-02T10:02:00.000Z", log: "/tmp/orc-1.log" } }

const withBacklog = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-thread-"))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const startedTask = async (root: string): Promise<void> => {
  const record = await run(addTask(root, spec))
  await run(claimTask(root, record.spec.id))
  await run(writeTaken(root, { spec: record.spec, hold: null, parked: null, state: started }))
}

const shape = (entries: ReadonlyArray<{ readonly at: string | null; readonly who: string; readonly kind: string }>) => entries.map((entry) => [entry.kind, entry.who, entry.at])

describe("orc backlog thread", () => {
  test("parses the task id and --json, and refuses anything else", () => {
    expect(parseDispatchArgs("backlog", ["thread", "orc-1"])).toEqual({ kind: "ShowThread", id: "orc-1", json: false })
    expect(parseDispatchArgs("backlog", ["thread", "orc-1", "--json"])).toEqual({ kind: "ShowThread", id: "orc-1", json: true })
    expect(parseDispatchArgs("backlog", ["thread", "nope"])).toEqual({ kind: "UsageError", detail: "orc backlog thread takes a task id, got \"nope\"" })
    expect(parseDispatchArgs("backlog", ["thread", "orc-1", "--all"])).toEqual({ kind: "UsageError", detail: "unexpected argument: --all" })
  })

  test("orders a hold, a parked question, a decider decision, its answer and a note by time rather than by the file each sits in", () => {
    const asked = "2026-11-02T10:20:00.000Z"
    const decided = "2026-11-02T10:30:00.000Z"
    const task: TaskRecord = {
      spec,
      hold: { reason: "Wait for the merge", until: null, questions: [], answer: { words: "Merged", at: "2026-11-02T09:10:00.000Z" }, at: "2026-11-02T09:00:00.000Z" },
      parked: { branch: "orc/orc-1", questions: [{ id: "r2", text: "How many retries?", asked, answer: { words: "Two retries", at: decided, relayedTo: null } }] },
      state: started
    }
    const item = {
      id: reviewQuestionId("orc-1", "r2", asked),
      item: {
        kind: "review-question" as const, task: "orc-1", text: "How many retries?", asked, owner: "decider" as const,
        decision: { kind: "answered" as const, reason: "the intent says twice", at: decided },
        state: { kind: "closed" as const, answer: { words: "Two retries", at: decided } }
      }
    }
    const note = { at: "2026-11-02T10:25:00.000Z", who: "captain", text: "the upload server is slow today" }
    expect(threadEntries(task, [item], [note])).toEqual([
      { at: "2026-11-02T09:00:00.000Z", who: "user", kind: "hold", id: null, text: "Wait for the merge" },
      { at: "2026-11-02T09:10:00.000Z", who: "user", kind: "answer", id: null, text: "Merged" },
      { at: asked, who: "worker", kind: "question", id: item.id, text: "How many retries?" },
      { at: "2026-11-02T10:25:00.000Z", who: "user", kind: "note", id: null, text: "the upload server is slow today" },
      { at: decided, who: "decider", kind: "decision", id: item.id, text: "answered: the intent says twice" },
      { at: decided, who: "decider", kind: "answer", id: item.id, text: "Two retries" }
    ])
  })

  test("a question a later park replaced still shows from its item instead of leaving only its decision", () => {
    const earlier = "2026-11-02T10:00:00.000Z"
    const later = "2026-11-02T11:00:00.000Z"
    const task: TaskRecord = {
      spec,
      hold: null,
      parked: { branch: "orc/orc-1", questions: [{ id: "r3", text: "Keep the flag?", asked: later, answer: null }] },
      state: started
    }
    const replaced = {
      id: reviewQuestionId("orc-1", "r1", earlier),
      item: {
        kind: "review-question" as const, task: "orc-1", text: "How many retries?", asked: earlier, owner: "user" as const,
        decision: { kind: "escalated" as const, reason: "the intent names no count", at: "2026-11-02T10:05:00.000Z" },
        state: { kind: "closed" as const, answer: { words: "Two", at: "2026-11-02T10:30:00.000Z" } }
      }
    }
    const current = {
      id: reviewQuestionId("orc-1", "r3", later),
      item: { kind: "review-question" as const, task: "orc-1", text: "Keep the flag?", asked: later, owner: "decider" as const, state: { kind: "open" as const } }
    }
    expect(threadEntries(task, [replaced, current], []).map((line) => [line.kind, line.who, line.id, line.text])).toEqual([
      ["question", "worker", replaced.id, "How many retries?"],
      ["decision", "decider", replaced.id, "escalated: the intent names no count"],
      ["answer", "user", replaced.id, "Two"],
      ["question", "worker", current.id, "Keep the flag?"]
    ])
  })

  test("a hold with no time sorts directly before its answer instead of first", () => {
    const task: TaskRecord = {
      spec,
      hold: {
        reason: "Wait for deployment", until: null, questions: [], answer: null, at: "2026-11-02T12:00:00.000Z",
        history: [{ reason: "Wait for the merge", until: "2026-11-03", questions: [], answer: { words: "Merged", at: "2026-11-02T11:00:00.000Z" } }]
      },
      parked: null,
      state: { kind: "new" }
    }
    const note = { at: "2026-11-02T10:00:00.000Z", who: "captain", text: "the merge waits on review" }
    expect(shape(threadEntries(task, [], [note]))).toEqual([
      ["note", "user", "2026-11-02T10:00:00.000Z"],
      ["hold", "user", null],
      ["answer", "user", "2026-11-02T11:00:00.000Z"],
      ["hold", "user", "2026-11-02T12:00:00.000Z"]
    ])
  })

  test("a decider answer names the decider, and the captain's answer to an escalated question names the user", () =>
    withBacklog(async (root) => {
      await startedTask(root)
      const asked = "2026-11-02T10:20:00.000Z"
      await run(askStartedTask(root, "orc-1", { asked, questions: [{ id: "r2", text: "How many retries?" }, { id: "r3", text: "Merge the PR once it is green?" }] }))
      await run(routeTaskItems(root, await run(listTasks(root)), asked))
      const ask: AskDecider = (request) =>
        request.prompt.includes("How many retries?")
          ? Effect.succeed(JSON.stringify({ decision: "answer", answer: "Two retries", reason: "the intent says twice" }))
          : request.prompt.includes("Merge the PR")
          ? Effect.succeed(JSON.stringify({ decision: "escalate", reason: "only the captain merges" }))
          : Effect.fail(new DeciderUnheard({ reason: "no reply in this test" }))
      await run(decideReviewQuestions(root, await run(listTasks(root)), ask))
      await run(answerTask(root, "orc-1", "r3=Yes, merge it", "2099-01-01T00:00:00.000Z"))
      const thread: unknown = JSON.parse(await run(threadText(root, "orc-1", true)))
      expect(thread).toMatchObject({
        schema: "orc.thread.v1",
        task: "orc-1",
        entries: [
          { kind: "question", who: "worker", id: reviewQuestionId("orc-1", "r2", asked) },
          { kind: "question", who: "worker", id: reviewQuestionId("orc-1", "r3", asked) },
          { kind: "decision", who: "decider", id: reviewQuestionId("orc-1", "r2", asked), text: "answered: the intent says twice" },
          { kind: "answer", who: "decider", id: reviewQuestionId("orc-1", "r2", asked), text: "Two retries" },
          { kind: "decision", who: "decider", id: reviewQuestionId("orc-1", "r3", asked), text: "escalated: only the captain merges" },
          { kind: "answer", who: "user", id: reviewQuestionId("orc-1", "r3", asked), text: "Yes, merge it", at: "2099-01-01T00:00:00.000Z" }
        ]
      })
    }))

  test("a decision matches its question by id before a later park replaces it and after", () => {
    const earlier = "2026-11-02T10:00:00.000Z"
    const decided = "2026-11-02T10:05:00.000Z"
    const later = "2026-11-02T11:00:00.000Z"
    const before: TaskRecord = {
      spec,
      hold: null,
      parked: { branch: "orc/orc-1", questions: [{ id: "r1", text: "How many retries?", asked: earlier, answer: { words: "Two", at: decided, relayedTo: null } }] },
      state: started
    }
    const stored = {
      id: reviewQuestionId("orc-1", "r1", earlier),
      item: {
        kind: "review-question" as const, task: "orc-1", text: "How many retries?", asked: earlier, owner: "decider" as const,
        decision: { kind: "answered" as const, reason: "the intent says twice", at: decided },
        state: { kind: "closed" as const, answer: { words: "Two", at: decided } }
      }
    }
    const beforeIds = threadEntries(before, [stored], []).filter((line) => line.kind !== "delivered").map((line) => line.id)
    expect(beforeIds).toEqual([stored.id, stored.id, stored.id])
    const after: TaskRecord = {
      spec,
      hold: null,
      parked: { branch: "orc/orc-1", questions: [{ id: "r3", text: "Keep the flag?", asked: later, answer: null }] },
      state: started
    }
    const current = {
      id: reviewQuestionId("orc-1", "r3", later),
      item: { kind: "review-question" as const, task: "orc-1", text: "Keep the flag?", asked: later, owner: "decider" as const, state: { kind: "open" as const } }
    }
    const afterByKind = new Map(threadEntries(after, [stored, current], []).map((line) => [line.kind + ":" + line.text, line.id]))
    expect(afterByKind.get("question:How many retries?")).toBe(stored.id)
    expect(afterByKind.get("decision:answered: the intent says twice")).toBe(stored.id)
    expect(afterByKind.get("answer:Two")).toBe(stored.id)
    expect(afterByKind.get("question:Keep the flag?")).toBe(current.id)
  })

  test("an answer at a different time than the answered decision names user instead of decider", () => {
    const asked = "2026-11-02T10:20:00.000Z"
    const captainAt = "2026-11-02T10:25:00.000Z"
    const deciderAt = "2026-11-02T10:30:00.000Z"
    const parked: TaskRecord = {
      spec,
      hold: null,
      parked: { branch: "orc/orc-1", questions: [{ id: "r2", text: "How many retries?", asked, answer: { words: "Three", at: captainAt, relayedTo: null } }] },
      state: started
    }
    const open = {
      id: reviewQuestionId("orc-1", "r2", asked),
      item: {
        kind: "review-question" as const, task: "orc-1", text: "How many retries?", asked, owner: "decider" as const,
        decision: { kind: "answered" as const, reason: "the intent says twice", at: deciderAt },
        state: { kind: "open" as const }
      }
    }
    expect(threadEntries(parked, [open], []).filter((line) => line.kind === "answer")).toEqual([
      { at: captainAt, who: "user", kind: "answer", id: open.id, text: "Three" }
    ])
    const replaced: TaskRecord = {
      spec,
      hold: null,
      parked: { branch: "orc/orc-1", questions: [{ id: "r3", text: "Keep the flag?", asked: "2026-11-02T11:00:00.000Z", answer: null }] },
      state: started
    }
    const closed = {
      id: open.id,
      item: {
        kind: "review-question" as const, task: "orc-1", text: "How many retries?", asked, owner: "decider" as const,
        decision: { kind: "answered" as const, reason: "the intent says twice", at: deciderAt },
        state: { kind: "closed" as const, answer: { words: "Three", at: captainAt } }
      }
    }
    expect(threadEntries(replaced, [closed], []).filter((line) => line.kind === "answer")).toEqual([
      { at: captainAt, who: "user", kind: "answer", id: closed.id, text: "Three" }
    ])
  })

  test("a delivered entry with no relay time names the handoff without an empty time", () => {
    const asked = "2026-11-02T10:20:00.000Z"
    const answered = "2026-11-02T10:30:00.000Z"
    const task: TaskRecord = {
      spec,
      hold: null,
      parked: { branch: "orc/orc-1", questions: [{ id: "r2", text: "How many retries?", asked, answer: { words: "Two", at: answered, relayedTo: "" } }] },
      state: started
    }
    const item = {
      id: reviewQuestionId("orc-1", "r2", asked),
      item: {
        kind: "review-question" as const, task: "orc-1", text: "How many retries?", asked, owner: "decider" as const,
        decision: { kind: "answered" as const, reason: "the intent says twice", at: answered },
        state: { kind: "open" as const }
      }
    }
    expect(threadEntries(task, [item], []).filter((line) => line.kind === "delivered")).toEqual([
      { at: null, who: "beat", kind: "delivered", id: item.id, text: "handed to the run that asked" }
    ])
  })

  test("refuses a task id the backlog does not hold", () =>
    withBacklog(async (root) => {
      await run(addTask(root, spec))
      await run(appendNote(root, "orc-9", { at: "2026-11-02T10:00:00.000Z", who: "captain", text: "stray" }))
      const refused = await run(threadText(root, "orc-9", false).pipe(Effect.flip))
      expect(refused).toMatchObject({ detail: "the backlog holds no orc-9" })
    }))

  test("a closed task still shows its thread instead of being refused", () =>
    withBacklog(async (root) => {
      await startedTask(root)
      await run(closeStartedTask(root, "orc-1", "done", "", { pr: null, report: null }, "2026-11-02T11:00:00.000Z"))
      await run(appendNote(root, "orc-1", { at: "2026-11-02T12:00:00.000Z", who: "captain", text: "merged by hand" }))
      expect(JSON.parse(await run(threadText(root, "orc-1", true)))).toEqual({
        schema: "orc.thread.v1",
        task: "orc-1",
        entries: [{ at: "2026-11-02T12:00:00.000Z", who: "user", kind: "note", id: null, text: "merged by hand" }]
      })
    }))

  test("a task with nothing said prints an empty thread rather than a bare header", () =>
    withBacklog(async (root) => {
      await run(addTask(root, spec))
      expect(await run(threadText(root, "orc-1", false))).toBe("nothing is said on orc-1 yet")
    }))
})
