import { strict as assert } from "node:assert"
import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit } from "effect"
import { attentionText } from "../../../packages/run/src/features/attention-list/index"
import { serveCorrections } from "../../../packages/run/src/widgets/beat/beat-close-runner"
import { routeTaskItems } from "../../../packages/run/src/entities/attention/attention"
import { addTask, claimTask, closeStartedTask, listTasks, writeTaken } from "../../../packages/run/src/entities/backlog/index"
import { type AskDecider, DeciderUnheard, decideReviewQuestions, type DeciderRequest } from "../../../packages/run/src/features/decider/index"
import { answersFor, answerTask, askStartedTask, correctionsDue, markAnswersRelayed } from "../../../packages/run/src/entities/parked-runs/index"
import { supportsEveryAnswer } from "../../lib/support-check"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const intent = "# Retry the upload\nRetry a failed upload twice, then give up.\n"

const spec = { title: "Retry the upload", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0 as const, created: "2026-11-02T10:00:00.000Z", body: intent }

const claim = { beat: "beat-1", machine: "linux", account: "main", takenAt: "2026-11-02T10:01:00.000Z" }

const asked = "2026-11-02T10:20:00.000Z"
const r2 = { id: "r2", text: "How many retries?" }
const r2Item = "orc-1.r2.2026-11-02T10_20_00_000Z"

type AskedQuestion = { readonly id: string; readonly text: string }

const withAskingTask = async (body: (root: string) => Promise<void>, questions: readonly [AskedQuestion, ...ReadonlyArray<AskedQuestion>] = [r2], taskBody: string = intent): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-decider-"))
  try {
    const record = await run(addTask(root, { ...spec, body: taskBody }))
    await run(claimTask(root, record.spec.id))
    await run(writeTaken(root, { spec: record.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-11-02T10:02:00.000Z", log: root + "/logs/orc-1.log" } } }))
    await run(askStartedTask(root, "orc-1", { asked, questions }))
    await run(routeTaskItems(root, await run(listTasks(root)), asked))
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const replies = (byQuestion: Readonly<Record<string, string>>, heard: Array<DeciderRequest> = [], home = "/nonexistent/orc-home"): AskDecider => ({
  home,
  ask: (request) => {
    heard.push(request)
    const matching = Object.entries(byQuestion).filter(([text]) => request.prompt.includes(text))
    matching.sort((a, b) => request.prompt.lastIndexOf(b[0]) - request.prompt.lastIndexOf(a[0]))
    const first = matching.at(0)
    return first === undefined ? Effect.fail(new DeciderUnheard({ reason: "no reply in this test" })) : Effect.succeed(first[1])
  },
  checkSupport: () => supportsEveryAnswer
})

const answer = JSON.stringify({ decision: "answer", answer: "Two retries", rule: "Retry a failed upload twice, then give up.", reason: "the intent says twice" })

const itemFile = async (root: string, id: string): Promise<unknown> => JSON.parse(await readFile(join(root, "attention", id + ".json"), "utf8"))

const decide = async (root: string, ask: AskDecider) => run(decideReviewQuestions(root, await run(listTasks(root)), ask))

describe("a decider overturn", () => {
  test("an overturned answer the run has not taken is the one the run receives, not the decider's", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: answer }))
      await run(answerTask(root, "orc-1", "r2=Three retries", "2099-01-01T00:00:00.000Z"))
      await run(routeTaskItems(root, await run(listTasks(root)), "2099-01-01T00:00:00.000Z"))
      const task = (await run(listTasks(root))).at(0)
      if (task === undefined) {
        throw new Error("the task is gone")
      }
      expect(answersFor(task, { asked, questions: [r2] }).map((question) => question.answer.words)).toEqual(["Three retries"])
      expect(task.parked?.questions.at(0)?.answer).toMatchObject({ words: "Three retries", overturned: { words: "Two retries", by: "decider" } })
      expect(correctionsDue(task)).toEqual([])
      expect(await itemFile(root, r2Item)).toMatchObject({ state: { kind: "closed", answer: { words: "Three retries" }, overturned: { words: "Two retries" } } })
      const shown = await run(attentionText(false, root))
      expect(shown).toContain("Decided by the owner:\n" + r2Item + ": Three retries\n")
      expect(shown).toContain("Decided by the agent:\n" + r2Item + ": Two retries (replaced)\n  question: " + r2.text + "\n  basis: the intent says twice")
    }, [r2])
  })

  test("a late mark of the relayed decider words leaves the captain's answer unmarked and due, instead of marking words the run never got", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: answer }))
      await run(answerTask(root, "orc-1", "r2=Three retries", "2099-01-01T00:00:00.000Z"))
      await run(markAnswersRelayed(root, "orc-1", asked, [{ id: "r2", asked, words: "Two retries" }]))
      const task = (await run(listTasks(root))).at(0)
      if (task === undefined) {
        throw new Error("the task is gone")
      }
      expect(task.parked?.questions.at(0)?.answer).toMatchObject({ words: "Three retries", relayedTo: null })
      expect(correctionsDue(task).map((question) => [question.id, question.answer.words, question.answer.overturned.words])).toEqual([["r2", "Three retries", "Two retries"]])
    }, [r2])
  })

  test("an overturned answer the run already took is due to it as a correction, instead of standing unsent", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: answer }))
      await run(markAnswersRelayed(root, "orc-1", asked, [{ id: "r2", asked, words: "Two retries" }]))
      await run(answerTask(root, "orc-1", "r2=Three retries", "2099-01-01T00:00:00.000Z"))
      const task = (await run(listTasks(root))).at(0)
      if (task === undefined) {
        throw new Error("the task is gone")
      }
      expect(correctionsDue(task).map((question) => [question.id, question.answer.words, question.answer.overturned.words])).toEqual([["r2", "Three retries", "Two retries"]])
    }, [r2])
  })

  test("a queued correction is reported as not delivered instead of handed", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: answer }))
      await run(markAnswersRelayed(root, "orc-1", asked, [{ id: "r2", asked, words: "Two retries" }]))
      await run(answerTask(root, "orc-1", "r2=Three retries", "2099-01-01T00:00:00.000Z"))
      const task = (await run(listTasks(root))).at(0)
      assert.ok(task)
      let seen: unknown = null
      const result = await run(serveCorrections(root, task, "linux", (corrections) => {
        seen = corrections
        return Effect.succeed("queued")
      }))
      expect(seen).toEqual([{ question: "r2", answer: "Three retries", decider: "owner" }])
      expect(result).toMatchObject({ kind: "answer-failed", task: "orc-1" })
      expect((await run(listTasks(root))).at(0)?.parked?.questions.at(0)?.answer?.relayedTo).toBeNull()
    }, [r2])
  })

  test("a queued overturn reported once is not reported again on a later beat", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: answer }))
      await run(markAnswersRelayed(root, "orc-1", asked, [{ id: "r2", asked, words: "Two retries" }]))
      await run(answerTask(root, "orc-1", "r2=Three retries", "2099-01-01T00:00:00.000Z"))
      let calls = 0
      let seen: unknown = null
      const correct = (corrections: ReadonlyArray<{ readonly question: string; readonly answer: string }>) => {
        calls += 1
        seen = corrections
        return Effect.succeed("queued")
      }
      const firstTask = (await run(listTasks(root))).at(0)
      assert.ok(firstTask)
      expect(await run(serveCorrections(root, firstTask, "linux", correct))).toMatchObject({ kind: "answer-failed", task: "orc-1" })
      expect(seen).toEqual([{ question: "r2", answer: "Three retries", decider: "owner" }])
      const queued = (await run(listTasks(root))).at(0)
      assert.ok(queued)
      expect(correctionsDue(queued)).toEqual([])
      expect(await run(serveCorrections(root, queued, "linux", correct))).toBeNull()
      expect(calls).toBe(1)
    }, [r2])
  })

  test("the captain's answer is never replaced by a second one, unlike a decider's", async () => {
    await withAskingTask(async (root) => {
      await run(answerTask(root, "orc-1", "r2=Two retries", "2026-11-02T10:22:00.000Z"))
      expect(Exit.isFailure(await run(Effect.exit(answerTask(root, "orc-1", "r2=Three retries", "2026-11-02T10:23:00.000Z"))))).toBe(true)
    })
  })

  test("a closed task refuses an overturn instead of rewriting an answer its run took", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: answer }))
      await run(closeStartedTask(root, "orc-1", "done", "the upload retries", { pr: null, report: null }, "2026-11-02T10:40:00.000Z"))
      await assert.rejects(run(answerTask(root, "orc-1", "r2=Three retries", "2099-01-01T00:00:00.000Z")))
      expect((await run(listTasks(root))).at(0)?.parked?.questions.at(0)?.answer).toMatchObject({ words: "Two retries" })
    }, [r2])
  })
})
