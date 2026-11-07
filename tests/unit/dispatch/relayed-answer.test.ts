import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { addTask, claimTask, listTasks, writeTaken } from "../../../packages/run/src/dispatch/backlog"
import { answersFor, answerTask, askStartedTask, handAnswersToResume, markAnswersRelayed, parkStartedTask } from "../../../packages/run/src/dispatch/parked"
import type { TaskRecord } from "../../../packages/run/src/dispatch/task-record"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const withBacklog = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-relayed-"))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const spec = { title: "Fix the thing", project: "orc", kind: "ship" as const, internal: false, machine: null, dependsOn: [], created: "2026-10-27T10:00:00.000Z", body: "# Fix the thing\n" }

const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-10-27T10:01:00.000Z" }

describe("a relayed answer", () => {
  const first = "2026-10-27T10:04:00.000Z"
  const second = "2026-10-27T10:20:00.000Z"
  const r2 = { id: "r2", text: "Keep the old flag?" }
  const r3 = { id: "r3", text: "Drop the old docs?" }
  const startStarted = async (root: string): Promise<void> => {
    const record = await run(addTask(root, spec))
    await run(claimTask(root, record.spec.id))
    await run(writeTaken(root, { spec: record.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-10-27T10:02:00.000Z", log: root + "/logs/orc-1.log" } } }))
  }
  const current = async (root: string): Promise<TaskRecord> => {
    const task = (await run(listTasks(root))).at(0)
    if (task === undefined) {
      throw new Error("the backlog holds no task")
    }
    return task
  }
  const relayedIds = async (root: string, asking: { readonly asked: string; readonly questions: readonly [typeof r2, ...Array<typeof r2>] }): Promise<ReadonlyArray<string>> => {
    const answered = answersFor(await current(root), asking)
    await run(markAnswersRelayed(root, "orc-1", asking.asked, answered.map((question) => question.id)))
    return answered.map((question) => question.id + "=" + question.answer.words)
  }
  test("a second answer to a wait of two questions relays both instead of reopening the first", async () => {
    await withBacklog(async (root) => {
      await startStarted(root)
      const asking = { asked: first, questions: [r2, r3] } as const
      expect(await run(askStartedTask(root, "orc-1", asking))).toBe(true)
      await run(answerTask(root, "orc-1", "r2=Keep it", "2026-10-27T10:05:00.000Z"))
      expect(await relayedIds(root, asking)).toEqual(["r2=Keep it"])
      expect(await run(askStartedTask(root, "orc-1", asking))).toBe(false)
      await run(answerTask(root, "orc-1", "r3=Drop them", "2026-10-27T10:09:00.000Z"))
      expect(await relayedIds(root, asking)).toEqual(["r2=Keep it", "r3=Drop them"])
      expect((await current(root)).parked?.questions).toEqual([
        { ...r2, asked: first, answer: { words: "Keep it", at: "2026-10-27T10:05:00.000Z", relayedTo: first } },
        { ...r3, asked: first, answer: { words: "Drop them", at: "2026-10-27T10:09:00.000Z", relayedTo: first } }
      ])
    })
  })
  test("a question asked again by a later asking asks anew under that asking instead of resending the old answer", async () => {
    await withBacklog(async (root) => {
      await startStarted(root)
      await run(askStartedTask(root, "orc-1", { asked: first, questions: [r2] }))
      await run(answerTask(root, "orc-1", "r2=Keep it", "2026-10-27T10:05:00.000Z"))
      await relayedIds(root, { asked: first, questions: [r2] })
      expect(await run(askStartedTask(root, "orc-1", { asked: second, questions: [r2] }))).toBe(true)
      expect((await current(root)).parked?.questions).toEqual([{ ...r2, asked: second, answer: null }])
      expect(answersFor(await current(root), { asked: second, questions: [r2] })).toEqual([])
      expect(await run(answerTask(root, "orc-1", "r2=Restore it", "2026-10-27T10:21:00.000Z"))).toMatchObject({ kind: "question", question: "r2" })
    })
  })
  test("parking after a wait ran out keeps the answers relayed to that wait instead of dropping what the run never sent", async () => {
    await withBacklog(async (root) => {
      await startStarted(root)
      await run(askStartedTask(root, "orc-1", { asked: first, questions: [r2, r3] }))
      await run(answerTask(root, "orc-1", "r2=Keep it", "2026-10-27T10:05:00.000Z"))
      await run(answerTask(root, "orc-1", "r3=Drop them", "2026-10-27T10:06:00.000Z"))
      await relayedIds(root, { asked: first, questions: [r2, r3] })
      const parked = await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ ...r3, asked: first }], "2026-10-27T10:35:00.000Z"))
      expect(parked.parked?.questions.map((question) => question.id + "=" + (question.answer?.words ?? ""))).toEqual(["r3=Drop them", "r2=Keep it"])
    })
  })
  test("parking drops an answer handed to an earlier asking instead of carrying it to the next run", async () => {
    await withBacklog(async (root) => {
      await startStarted(root)
      await run(askStartedTask(root, "orc-1", { asked: first, questions: [r2] }))
      await run(answerTask(root, "orc-1", "r2=Keep it", "2026-10-27T10:05:00.000Z"))
      await relayedIds(root, { asked: first, questions: [r2] })
      const parked = await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ ...r2, asked: second }], "2026-10-27T10:35:00.000Z"))
      expect(parked.parked?.questions).toEqual([{ ...r2, asked: second, answer: null }])
    })
  })
  test("a question parked with no wait is stamped with the park time instead of left with no asking", async () => {
    await withBacklog(async (root) => {
      await startStarted(root)
      const parked = await run(parkStartedTask(root, "orc-1", "orc/orc-1", [r2], "2026-10-27T10:35:00.000Z"))
      expect(parked.parked?.questions).toEqual([{ ...r2, asked: "2026-10-27T10:35:00.000Z", answer: null }])
    })
  })
  test("a question with the legacy used flag asks anew instead of handing the old answer again", async () => {
    await withBacklog(async (root) => {
      await startStarted(root)
      await writeFile(
        join(root, "taken", "orc-1.md"),
        ["---", `id: ${JSON.stringify("orc-1")}`, `title: ${JSON.stringify(spec.title)}`, `project: ${JSON.stringify(spec.project)}`, `kind: ${JSON.stringify("ship")}`, `machine: null`, `depends_on: ${JSON.stringify([])}`, `created: ${JSON.stringify(spec.created)}`, `parked_branch: ${JSON.stringify("orc/orc-1")}`, `parked_questions: ${JSON.stringify([{ id: r2.id, text: r2.text, answer: "Keep it", answered_at: "2026-10-27T10:05:00.000Z", used: true }])}`, `beat: ${JSON.stringify(claim.beat)}`, `taken_for: ${JSON.stringify(claim.machine)}`, `account: ${JSON.stringify(claim.account)}`, `taken_at: ${JSON.stringify(claim.takenAt)}`, `started_at: ${JSON.stringify("2026-10-27T10:02:00.000Z")}`, `start_log: ${JSON.stringify(root + "/logs/orc-1.log")}`, "---", spec.title + "\n"].join("\n")
      )
      expect(await run(askStartedTask(root, "orc-1", { asked: second, questions: [r2] }))).toBe(true)
      expect((await current(root)).parked?.questions).toEqual([{ ...r2, asked: second, answer: null }])
      expect(answersFor(await current(root), { asked: second, questions: [r2] })).toEqual([])
    })
  })
  test("a resume hands every answer to the asking it answers instead of leaving it to answer a later asking", () => {
    const record: TaskRecord = {
      spec: { ...spec, id: "orc-1", kind: "ship", internal: false, machine: null, dependsOn: [], created: "2026-10-27" },
      hold: null,
      parked: {
        branch: "orc/orc-1",
        questions: [
          { ...r2, asked: first, answer: { words: "Keep it", at: "2026-10-27T10:05:00.000Z", relayedTo: null } },
          { ...r3, asked: second, answer: { words: "Drop them", at: "2026-10-27T10:25:00.000Z", relayedTo: second } }
        ]
      },
      state: { kind: "new" }
    }
    const resumed = handAnswersToResume(record)
    expect(resumed.parked?.questions.map((question) => question.answer?.relayedTo)).toEqual([first, second])
    expect(answersFor(resumed, { asked: "2026-10-27T11:00:00.000Z", questions: [r2, r3] })).toEqual([])
  })
})
