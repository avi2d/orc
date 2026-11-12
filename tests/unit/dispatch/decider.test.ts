import { strict as assert } from "node:assert"
import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { attentionJson, attentionText } from "../../../packages/run/src/dispatch/attention-view"
import { claimDeciding, openItems, readAttention, routeTaskItems } from "../../../packages/run/src/entities/attention/attention"
import { addTask, claimTask, closeStartedTask, listTasks, writeTaken } from "../../../packages/run/src/entities/backlog/index"
import { type AskDecider, DeciderUnheard, decideReviewQuestions, type DeciderRequest } from "../../../packages/run/src/dispatch/decider"
import { answerTask, askStartedTask, parkStartedTask } from "../../../packages/run/src/entities/parked-runs/index"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const intent = "# Retry the upload\nRetry a failed upload twice, then give up.\n"

const spec = { title: "Retry the upload", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], created: "2026-11-02T10:00:00.000Z", body: intent }

const claim = { beat: "beat-1", machine: "linux", account: "main", takenAt: "2026-11-02T10:01:00.000Z" }

const asked = "2026-11-02T10:20:00.000Z"
const r2 = { id: "r2", text: "How many retries?" }
const r3 = { id: "r3", text: "Merge the PR once it is green?" }
const r2Item = "orc-1.r2.2026-11-02T10_20_00_000Z"
const r3Item = "orc-1.r3.2026-11-02T10_20_00_000Z"

const withAskingTask = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-decider-"))
  try {
    const record = await run(addTask(root, spec))
    await run(claimTask(root, record.spec.id))
    await run(writeTaken(root, { spec: record.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-11-02T10:02:00.000Z", log: root + "/logs/orc-1.log" } } }))
    await run(askStartedTask(root, "orc-1", { asked, questions: [r2, r3] }))
    await run(routeTaskItems(root, await run(listTasks(root)), asked))
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const replies = (byQuestion: Readonly<Record<string, string>>, heard: Array<DeciderRequest> = []): AskDecider => (request) => {
  heard.push(request)
  const reply = Object.entries(byQuestion).find(([text]) => request.prompt.includes(text))?.[1]
  return reply === undefined ? Effect.fail(new DeciderUnheard({ reason: "no reply in this test" })) : Effect.succeed(reply)
}

const answer = JSON.stringify({ decision: "answer", answer: "Two retries", reason: "the intent says twice" })
const escalate = JSON.stringify({ decision: "escalate", reason: "only the captain merges" })

const itemFile = async (root: string, id: string): Promise<unknown> => JSON.parse(await readFile(join(root, "attention", id + ".json"), "utf8"))

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const filedAt = (filed: unknown, ...path: ReadonlyArray<string>): string | undefined => {
  let current: unknown = filed
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined
    }
    current = current[key]
  }
  return typeof current === "string" ? current : undefined
}

const decide = async (root: string, ask: AskDecider) => run(decideReviewQuestions(root, await run(listTasks(root)), ask))

describe("the decider", () => {
  test("a live question whose item cannot open never reaches the backlog instead of asking alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "orc-decider-early-"))
    try {
      const record = await run(addTask(root, spec))
      await run(claimTask(root, record.spec.id))
      await run(writeTaken(root, { spec: record.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-11-02T10:02:00.000Z", log: root + "/logs/orc-1.log" } } }))
      await run(askStartedTask(root, "orc-1", { asked, questions: [r2] }))
      expect((await run(listTasks(root))).at(0)?.parked?.questions.map((question) => question.id)).toEqual(["r2"])
      expect((await run(openItems(root))).map((entry) => entry.id)).toEqual([r2Item])
      expect((await run(openItems(root))).map((entry) => entry.item.owner)).toEqual(["decider"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
    const blocked = await mkdtemp(join(tmpdir(), "orc-decider-blocked-"))
    try {
      const record = await run(addTask(blocked, spec))
      await run(claimTask(blocked, record.spec.id))
      await run(writeTaken(blocked, { spec: record.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-11-02T10:02:00.000Z", log: blocked + "/logs/orc-1.log" } } }))
      await writeFile(join(blocked, "attention"), "blocked")
      await assert.rejects(run(askStartedTask(blocked, "orc-1", { asked, questions: [r2] })))
      expect((await run(listTasks(blocked))).at(0)?.parked).toBeNull()
    } finally {
      await rm(blocked, { recursive: true, force: true })
    }
  })
  test("a parked question whose item cannot open stays taken instead of parking alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "orc-decider-parked-"))
    try {
      const record = await run(addTask(root, spec))
      await run(claimTask(root, record.spec.id))
      await run(writeTaken(root, { spec: record.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-11-02T10:02:00.000Z", log: root + "/logs/orc-1.log" } } }))
      await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ id: "r2", text: "How many retries?" }], "2026-11-02T10:35:00.000Z"))
      expect((await run(listTasks(root))).at(0)?.parked?.questions.map((question) => question.id)).toEqual(["r2"])
      expect((await run(openItems(root))).map((entry) => entry.id)).toEqual(["orc-1.r2.2026-11-02T10_35_00_000Z"])
      expect((await run(openItems(root))).map((entry) => entry.item.owner)).toEqual(["decider"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
    const blocked = await mkdtemp(join(tmpdir(), "orc-decider-park-blocked-"))
    try {
      const record = await run(addTask(blocked, spec))
      await run(claimTask(blocked, record.spec.id))
      await run(writeTaken(blocked, { spec: record.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-11-02T10:02:00.000Z", log: blocked + "/logs/orc-1.log" } } }))
      await writeFile(join(blocked, "attention"), "blocked")
      await assert.rejects(run(parkStartedTask(blocked, "orc-1", "orc/orc-1", [{ id: "r2", text: "How many retries?" }], "2026-11-02T10:35:00.000Z")))
      const task = (await run(listTasks(blocked))).at(0)
      expect(task?.state.kind).toBe("started")
      expect(task?.parked).toBeNull()
    } finally {
      await rm(blocked, { recursive: true, force: true })
    }
  })
  test("a review question the beat routes is owned by the decider, not handed straight to the user", async () => {
    await withAskingTask(async (root) => {
      expect((await run(openItems(root))).map((entry) => entry.item.owner)).toEqual(["decider", "decider"])
    })
  })

  test("a decider answer closes its item through the task's answer and records its reason, instead of leaving the item open", async () => {
    await withAskingTask(async (root) => {
      const before = new Date().toISOString()
      await decide(root, replies({ [r2.text]: answer, [r3.text]: escalate }))
      const after = new Date().toISOString()
      const task = (await run(listTasks(root))).at(0)
      const stored = task?.parked?.questions.find((question) => question.id === "r2")?.answer
      expect(stored).toMatchObject({ words: "Two retries" })
      expect(await itemFile(root, r2Item)).toMatchObject({
        owner: "decider",
        decision: { kind: "answered", reason: "the intent says twice" },
        state: { kind: "closed", answer: { words: "Two retries" } }
      })
      const filed = await itemFile(root, r2Item)
      for (const at of [stored?.at, filedAt(filed, "decision", "at"), filedAt(filed, "state", "answer", "at")]) {
        expect(at !== undefined && at >= before && at <= after).toBe(true)
      }
    })
  })

  test("an escalated question turns to the user and stays open with the decider's reason, instead of being answered", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: answer, [r3.text]: escalate }))
      expect((await run(openItems(root))).map((entry) => entry.id)).toEqual([r3Item])
      expect(await itemFile(root, r3Item)).toMatchObject({ owner: "user", decision: { kind: "escalated", reason: "only the captain merges" }, state: { kind: "open" } })
      expect((await run(listTasks(root))).at(0)?.parked?.questions.find((question) => question.id === "r3")?.answer).toBeNull()
    })
  })

  test("each question gets its own call carrying the task intent and the written policy, not one call for the batch", async () => {
    await withAskingTask(async (root) => {
      const heard: Array<DeciderRequest> = []
      await decide(root, replies({ [r2.text]: escalate, [r3.text]: escalate }, heard))
      const policy = await readFile(join(import.meta.dir, "../../../packages/run/agents/decider-policy.md"), "utf8")
      expect(heard).toHaveLength(2)
      for (const [index, question] of [r2, r3].entries()) {
        expect(heard[index]?.policy).toBe(policy)
        expect(heard[index]?.prompt).toContain("Retry a failed upload twice, then give up.")
        expect(heard[index]?.prompt).toContain(question.text)
        expect(heard[index]?.prompt).not.toContain((index === 0 ? r3 : r2).text)
      }
    })
  })

  test("a question the user owns never reaches the decider, so an escalated one is not asked twice", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: escalate, [r3.text]: escalate }))
      const heard: Array<DeciderRequest> = []
      expect(await decide(root, replies({ [r2.text]: answer }, heard))).toEqual([])
      expect(heard).toEqual([])
    })
  })

  test("a decider answer lists under decided with its words, and leaves the list once its task closes, while a user answer never lists there", async () => {
    await withAskingTask(async (root) => {
      const before = new Date().toISOString()
      await decide(root, replies({ [r2.text]: answer, [r3.text]: escalate }))
      const after = new Date().toISOString()
      await run(answerTask(root, "orc-1", "r3=Keep the old flag", "2026-11-02T10:22:00.000Z"))
      await run(routeTaskItems(root, await run(listTasks(root)), "2026-11-02T10:22:00.000Z"))
      const decided = (await run(readAttention(root, await run(listTasks(root))))).decided
      expect(decided.map((entry) => entry.id)).toEqual([r2Item])
      const view = attentionJson(await run(openItems(root)), "2026-11-02T10:30:00.000Z", decided)
      expect(view.items).toEqual([])
      expect(view.decided).toHaveLength(1)
      const entry = view.decided.at(0)
      expect(entry).toMatchObject({
        id: r2Item,
        kind: "review-question",
        task: "orc-1",
        text: r2.text,
        asked,
        owner: "decider",
        decision: { kind: "answered", reason: "the intent says twice" },
        answer: { words: "Two retries" }
      })
      for (const at of [entry?.decision.at, entry?.answer.at]) {
        expect(at !== undefined && at >= before && at <= after).toBe(true)
      }
      expect(await run(attentionText(false, root))).toContain("Decided:\nanswered " + r2Item + ": Two retries (the intent says twice)")
      await run(closeStartedTask(root, "orc-1", "done", "the upload retries", { pr: null, report: null }, "2026-11-02T10:40:00.000Z"))
      expect((await run(readAttention(root, await run(listTasks(root))))).decided).toEqual([])
    })
  })

  test("a beat skips an item another beat is deciding instead of asking the model twice", async () => {
    await withAskingTask(async (root) => {
      const claimedAt = new Date().toISOString()
      expect(await run(claimDeciding(root, r2Item, claimedAt))).toBe(true)
      const heard: Array<DeciderRequest> = []
      await decide(root, replies({ [r2.text]: answer, [r3.text]: escalate }, heard))
      expect(heard).toHaveLength(1)
      expect((await run(openItems(root))).map((entry) => entry.id)).toEqual([r2Item, r3Item])
      expect(await itemFile(root, r2Item)).toMatchObject({ owner: "decider", deciding: { at: claimedAt }, state: { kind: "open" } })
    })
  })

  test("a deciding mark older than the decider timeout is retaken instead of stalling the question", async () => {
    await withAskingTask(async (root) => {
      expect(await run(claimDeciding(root, r2Item, "2026-11-02T10:17:00.000Z"))).toBe(true)
      const heard: Array<DeciderRequest> = []
      const before = new Date().toISOString()
      await decide(root, replies({ [r2.text]: answer, [r3.text]: escalate }, heard))
      const after = new Date().toISOString()
      expect(heard).toHaveLength(2)
      expect(await itemFile(root, r2Item)).toMatchObject({
        decision: { kind: "answered", reason: "the intent says twice" },
        state: { kind: "closed", answer: { words: "Two retries" } }
      })
      const filed = await itemFile(root, r2Item)
      for (const at of [filedAt(filed, "decision", "at"), filedAt(filed, "state", "answer", "at")]) {
        expect(at !== undefined && at >= before && at <= after).toBe(true)
      }
    })
  })

  test("a reply orc cannot read or a call that fails escalates to the user instead of answering", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: "Sure, two retries sounds right." }))
      expect((await run(openItems(root))).map((entry) => entry.item.owner)).toEqual(["user", "user"])
      expect((await run(listTasks(root))).at(0)?.parked?.questions.every((question) => question.answer === null)).toBe(true)
    })
  })

})
