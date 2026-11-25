import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, type FileSystem } from "effect"
import { openItems, routeTaskItems } from "../../../packages/run/src/entities/attention/attention"
import { addTask, answerWait, type BacklogError, claimTask, listTasks, type TaskRecord, writeTaken } from "../../../packages/run/src/entities/backlog/index"
import { answerTask, carryRecordedAnswers, handAnswersToResume, parkStartedTask } from "../../../packages/run/src/entities/parked-runs/index"
import { readRequest } from "../../../packages/run/src/features/queueing-a-task/runner-request"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const withBacklog = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-owner-answer-"))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const current = async (root: string): Promise<TaskRecord> => {
  const task = (await run(listTasks(root))).at(0)
  if (task === undefined) {
    throw new Error("the backlog holds no task")
  }
  return task
}

const claim = { beat: "beat-1", machine: "winbox", account: "main", takenAt: "2026-11-21T19:55:00.000Z" }

const resumeOnce = async (root: string, id: string): Promise<void> => {
  await run(claimTask(root, id))
  await run(writeTaken(root, { ...handAnswersToResume(await current(root)), state: { kind: "started", claim, started: { at: "2026-11-21T19:55:04.000Z", log: root + "/logs/" + id + ".log" } } }))
}

describe("a parked run re-reporting a question of the asking it resumes", () => {
  const firstAsking = "2026-11-20T13:06:44.371Z"
  const laterAsking = "2026-11-20T15:48:18.106Z"
  const r1 = { id: "R1", text: "Keep the retry marker on send back?" }
  const r4 = { id: "R4", text: "Drop the legacy flag?" }
  const spec = { title: "Fix the thing", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 1 as const, created: "2026-11-20T12:00:00.000Z", body: "# Fix the thing\n" }

  test("keeps the answer already relayed to that asking instead of writing the question back unanswered under its closed item", async () => {
    await withBacklog(async (root) => {
      const added = await run(addTask(root, spec))
      await run(claimTask(root, added.spec.id))
      await run(writeTaken(root, { spec: added.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-11-20T13:00:00.000Z", log: root + "/logs/orc-1.log" } } }))
      await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ ...r1, asked: firstAsking }], "2026-11-20T13:10:00.000Z"))
      await run(answerTask(root, "orc-1", "R1=Keep it", "2026-11-20T14:27:36.893Z"))
      await run(routeTaskItems(root, [await current(root)], "2026-11-20T14:27:40.000Z"))
      await resumeOnce(root, "orc-1")
      const parked = await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ ...r4, asked: laterAsking, asking: laterAsking }, { ...r1, asked: firstAsking, asking: firstAsking }], "2026-11-20T16:00:00.000Z"))
      expect(parked.parked?.questions.map((question) => question.id + "=" + (question.answer?.words ?? "unanswered"))).toEqual(["R4=unanswered", "R1=Keep it"])
      expect(answerWait(parked, () => false)).toBe("parked on orc/orc-1 for the captain's answer to R4")
    })
  })
})

const task174 = "orc-174"
const r3Asked = "2026-11-20T22:49:20.578Z"
const r3Item = task174 + ".R3.2026-11-20T22_49_20_578Z"
const r3Text = "Should a decision record name the owner and the agent in one field or two?"
const ownerAnswer = { words: "Keep both, the owner field and the agent field", at: "2026-11-21T16:53:47.492Z" }

const parkedTaskFile = [
  "---",
  `id: "orc-174"`,
  `title: "orc: decision records carry who decided, the owner or the agent"`,
  `project: "orc"`,
  `kind: "ship"`,
  `machine: null`,
  `parent: "orc-173"`,
  `depends_on: []`,
  `priority: 1`,
  `created: "2026-11-20T20:15:30.767Z"`,
  `parked_branch: "orc/orc-174"`,
  `parked_questions: ${JSON.stringify([
    { id: "R3", text: r3Text, asked_at: r3Asked },
    { id: "R2", text: "Does the decider field apply to old records?", asked_at: "2026-11-21T20:51:28.621Z", answer: "Only new records", answered_at: "2026-11-21T20:51:39.299Z", answered_by: "decider", relayed_to: "2026-11-21T20:51:28.621Z" }
  ])}`,
  `parked_origin: {"machine":"winbox","run":"20261121-195504-157c10"}`,
  "---",
  "Add a required decider field to the decision record schema.",
  ""
].join("\n")

const closedItem = {
  kind: "review-question",
  task: task174,
  text: r3Text,
  asked: r3Asked,
  owner: "user",
  decision: { kind: "escalated", reason: "the task does not settle it", at: "2026-11-20T22:53:40.359Z" },
  state: { kind: "closed", answer: ownerAnswer }
}

const withParked174 = async (body: (root: string) => Promise<void>): Promise<void> =>
  withBacklog(async (root) => {
    await mkdir(join(root, "new"), { recursive: true })
    await mkdir(join(root, "attention"), { recursive: true })
    await writeFile(join(root, "new", task174 + ".md"), parkedTaskFile)
    await writeFile(join(root, "attention", r3Item + ".json"), JSON.stringify(closedItem, null, 2) + "\n")
    await body(root)
  })

type Carry = (root: string, tasks: ReadonlyArray<TaskRecord>) => Effect.Effect<ReadonlyArray<TaskRecord>, BacklogError, FileSystem.FileSystem>

const leavesAnswerOutOfTaskFile: Carry = (_root, tasks) => Effect.succeed(tasks)

const r3AnswerAfterCarry = async (root: string, carry: Carry): Promise<string | null> => {
  await run(carry(root, await run(listTasks(root))))
  const r3 = (await current(root)).parked?.questions.find((question) => question.id === "R3")
  return r3?.answer?.words ?? null
}

describe("the beat carrying a recorded owner answer into its task file", () => {
  test("writes the answer of the closed item into the parked question instead of leaving the task waiting on it", async () => {
    await withParked174(async (root) => {
      expect(answerWait(await current(root), () => false)).toBe("parked on orc/orc-174 for the captain's answer to R3")
      expect(await r3AnswerAfterCarry(root, carryRecordedAnswers)).toBe(ownerAnswer.words)
      const carried = await current(root)
      expect(carried.parked?.questions.find((question) => question.id === "R3")?.answer).toEqual({ ...ownerAnswer, relayedTo: null })
      expect(answerWait(carried, () => false)).toBeNull()
    })
  })

  test("the same check fails a carry that leaves the answer out of the task file", async () => {
    await withParked174(async (root) => {
      expect(await r3AnswerAfterCarry(root, leavesAnswerOutOfTaskFile)).toBeNull()
      expect(answerWait(await current(root), () => false)).toBe("parked on orc/orc-174 for the captain's answer to R3")
    })
  })

  test("hands the carried answer to the resumed run instead of resuming it without the owner's words", async () => {
    await withParked174(async (root) => {
      await run(carryRecordedAnswers(root, await run(listTasks(root))))
      await resumeOnce(root, task174)
      const request = await run(readRequest({ ORC_TASK_ID: task174, ORC_TASK_FILE: join(root, "taken", task174 + ".md"), ORC_TASK_CHECKOUT: "/checkout", ORC_TASK_PROVIDER: "keyed" }, Effect.succeed("")))
      expect(request.answers).toContainEqual({ question: "R3", answer: ownerAnswer.words })
    })
  })

  test("leaves the task file as it was when no closed item holds an answer, instead of rewriting it each beat", async () => {
    await withParked174(async (root) => {
      await rm(join(root, "attention", r3Item + ".json"))
      const before = await readFile(join(root, "new", task174 + ".md"), "utf8")
      await run(carryRecordedAnswers(root, await run(listTasks(root))))
      expect(await readFile(join(root, "new", task174 + ".md"), "utf8")).toBe(before)
    })
  })
})

describe("the beat's safety net for a parked question no open item asks", () => {
  const unaskedId = task174 + ".unasked-question.2026-11-20T22_49_20_578Z"

  test("opens one owner item naming the question instead of leaving the task parked with nothing to answer", async () => {
    await withParked174(async (root) => {
      await run(routeTaskItems(root, [await current(root)], "2026-11-21T21:30:00.000Z"))
      const open = await run(openItems(root))
      expect(open.map((entry) => entry.id)).toEqual([unaskedId])
      expect(open[0]?.item).toMatchObject({
        kind: "unasked-question",
        task: task174,
        owner: "user",
        subject: "the unasked questions of orc-174: R3",
        recommendation: "answer",
        state: { kind: "open" }
      })
      expect(open[0]?.item.text).toContain("R3: " + r3Text)
    })
  })

  test("withdraws the item once the question has its answer instead of keeping a stale ask open", async () => {
    await withParked174(async (root) => {
      await run(routeTaskItems(root, [await current(root)], "2026-11-21T21:30:00.000Z"))
      await run(answerTask(root, task174, "R3=two fields", "2026-11-21T21:31:00.000Z"))
      await run(routeTaskItems(root, [await current(root)], "2026-11-21T21:32:00.000Z"))
      expect(await run(openItems(root))).toEqual([])
      expect(JSON.parse(await readFile(join(root, "attention", unaskedId + ".json"), "utf8"))).toMatchObject({
        state: { kind: "withdrawn", reason: "each question it named has an answer or an open item" }
      })
    })
  })

  test("names a question that loses its item later in the open item instead of keeping only the first one", async () => {
    await withParked174(async (root) => {
      await run(routeTaskItems(root, [await current(root)], "2026-11-21T21:30:00.000Z"))
      const r5Asked = "2026-11-21T21:00:00.000Z"
      const r5Text = "Should the record keep the old owner field name?"
      const taskFile = join(root, "new", task174 + ".md")
      const withR5 = (await readFile(taskFile, "utf8")).replace(`parked_questions: [`, `parked_questions: [${JSON.stringify({ id: "R5", text: r5Text, asked_at: r5Asked })},`)
      await writeFile(taskFile, withR5)
      await writeFile(join(root, "attention", task174 + ".R5.2026-11-21T21_00_00_000Z.json"), JSON.stringify({ ...closedItem, text: r5Text, asked: r5Asked }, null, 2) + "\n")
      await run(routeTaskItems(root, [await current(root)], "2026-11-21T21:32:00.000Z"))
      const open = await run(openItems(root))
      expect(open.map((entry) => entry.id)).toEqual([unaskedId])
      expect(open[0]?.item.subject).toBe("the unasked questions of orc-174: R5, R3")
      expect(open[0]?.item.text).toContain("R5: " + r5Text)
    })
  })

  test("opens nothing more for a question its own open item still asks, instead of asking it twice", async () => {
    await withParked174(async (root) => {
      await rm(join(root, "attention", r3Item + ".json"))
      await run(routeTaskItems(root, [await current(root)], "2026-11-21T21:30:00.000Z"))
      expect((await run(openItems(root))).map((entry) => entry.id)).toEqual([r3Item])
    })
  })
})
