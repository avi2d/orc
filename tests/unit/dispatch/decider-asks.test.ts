import { strict as assert } from "node:assert"
import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Array as Arr, Effect, Fiber, Schema } from "effect"
import { openItems } from "../../../packages/run/src/entities/attention/attention"
import { addTask, claimTask, listTasks, writeTaken } from "../../../packages/run/src/entities/backlog/index"
import { askStartedTask, parkStartedTask } from "../../../packages/run/src/entities/parked-runs/index"
import { Asking, askingFileName, waitForAnswers } from "../../../packages/run/src/entities/review-gate/answer-wait"
import { driveNoMistakes, type NoMistakesRunner } from "../../../packages/run/src/entities/review-gate/no-mistakes"
import { type AskDecider, type DeciderRequest, decideReviewQuestions } from "../../../packages/run/src/features/decider/index"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const intent = "# Retry the upload\nRetry a failed upload twice, then give up.\n"

const spec = { title: "Retry the upload", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0 as const, created: "2026-11-02T10:00:00.000Z", body: intent }

const claim = { beat: "beat-1", machine: "linux", account: "main", takenAt: "2026-11-02T10:01:00.000Z" }

const answer = JSON.stringify({ decision: "answer", answer: "Two retries", rule: "Retry a failed upload twice, then give up.", reason: "the intent says twice" })

const gateAsking = (row: string, columns = "id,severity,file,action,description,question_action"): string => [
  "run:",
  "  id: \"01RUN\"",
  "  branch: orc/orc-1",
  "  status: awaiting_approval",
  "  findings[1]{" + columns + "}:",
  "    " + row,
  "gate: review"
].join("\n")

const parkedAt = (stdout: string): NoMistakesRunner => ({
  start: () => Effect.succeed({ stdout, stderr: "", exitCode: 0 }),
  reattach: Effect.succeed({ stdout, stderr: "", exitCode: 0 }),
  respond: () => Effect.die("no gate response is expected"),
  answer: () => Effect.die("no answer is expected"),
  status: () => Effect.succeed({ stdout: "steps[0]{step,status,findings,duration_ms}:", stderr: "", exitCode: 0 }),
  logs: () => Effect.die("no step has findings")
})

const listening = (heard: Array<DeciderRequest>): AskDecider => ({
  home: "/nonexistent/orc-home",
  ask: (request) => {
    heard.push(request)
    return Effect.succeed(answer)
  }
})

const withStartedTask = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-decider-asks-"))
  try {
    const record = await run(addTask(root, spec))
    await run(claimTask(root, record.spec.id))
    await run(writeTaken(root, { spec: record.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-11-02T10:02:00.000Z", log: root + "/logs/orc-1.log" } } }))
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const parkThroughGate = async (root: string, stdout: string): Promise<void> => {
  const runDir = await mkdtemp(join(tmpdir(), "orc-decider-asks-run-"))
  try {
    const record = await run(driveNoMistakes({ runner: parkedAt(stdout), taskFile: "/task.md", runDir }))
    assert.ok(Arr.isReadonlyArrayNonEmpty(record.openQuestions))
    await run(parkStartedTask(root, "orc-1", "orc/orc-1", record.openQuestions, "2026-11-02T10:35:00.000Z"))
  } finally {
    await rm(runDir, { recursive: true, force: true })
  }
}

const decideAll = async (root: string, heard: Array<DeciderRequest>) => run(decideReviewQuestions(root, await run(listTasks(root)), listening(heard)))

const readAskingRaw = async (runDir: string, deadline: number): Promise<string> => {
  while (true) {
    try {
      return await readFile(join(runDir, askingFileName), "utf8")
    } catch {
      if (Date.now() >= deadline) {
        throw new Error("asking.json never appeared")
      }
      await Bun.sleep(10)
    }
  }
}

describe("the asked action of a no-mistakes review question", () => {
  test("a routine question with action none reaches the decider without a guarded word", async () => {
    await withStartedTask(async (root) => {
      await parkThroughGate(root, gateAsking("question-1,warning,,ask-user,How many retries?,none"))
      const heard: Array<DeciderRequest> = []
      const decided = await decideAll(root, heard)
      expect(heard.length).toBe(1)
      expect(decided.map((entry) => entry.verdict.kind)).toEqual(["answered"])
    })
  })

  test("a routine question with action none reaches the decider even when its words name a guarded topic", async () => {
    await withStartedTask(async (root) => {
      await parkThroughGate(root, gateAsking("question-1,warning,,ask-user,Should the report look at both retry counters?,none"))
      expect((await run(listTasks(root))).at(0)?.parked?.questions.at(0)?.asks).toBe("none")
      const heard: Array<DeciderRequest> = []
      const decided = await decideAll(root, heard)
      expect(heard.length).toBe(1)
      expect(decided.map((entry) => entry.verdict.kind)).toEqual(["answered"])
    })
  })

  test.each([
    ["merge", "Is this branch ready?", "merge"],
    ["delete", "Clear the stale branch orc/old?", "delete unlanded work"],
    ["login", "Refresh the GitHub session first?", "log in"]
  ])("a question that asks the owner to %s goes to the owner although no guarded word appears", async (asks, text, named) => {
    await withStartedTask(async (root) => {
      await parkThroughGate(root, gateAsking("question-1,warning,,ask-user," + text + "," + asks))
      const heard: Array<DeciderRequest> = []
      const decided = await decideAll(root, heard)
      expect(heard.length).toBe(0)
      const verdict = decided.at(0)?.verdict
      expect(verdict?.kind).toBe("escalated")
      expect(verdict?.kind === "escalated" ? verdict.reason : "").toContain("asks the owner to " + named)
      expect((await run(openItems(root))).map((entry) => entry.item.owner)).toEqual(["user"])
    })
  })

  test("an ask-user finding with action none bypasses guarded words instead of escalating", async () => {
    await withStartedTask(async (root) => {
      await parkThroughGate(root, gateAsking("3,warning,,ask-user,Should the report look at both retry counters?,none"))
      expect((await run(listTasks(root))).at(0)?.parked?.questions.at(0)?.asks).toBe("none")
      const heard: Array<DeciderRequest> = []
      const decided = await decideAll(root, heard)
      expect(heard.length).toBe(1)
      expect(decided.map((entry) => entry.verdict.kind)).toEqual(["answered"])
    })
  })

  test.each([
    ["merge", "Land this before the schema change?", "merge"],
    ["delete", "Clear the stale branch orc/old?", "delete unlanded work"],
    ["login", "Refresh the GitHub session first?", "log in"],
    ["push", "Send this branch upstream?", "push"],
    ["release", "Ship this version now?", "release"]
  ])("an ask-user finding requesting %s reaches the owner instead of the decider", async (asks, text, named) => {
    await withStartedTask(async (root) => {
      await parkThroughGate(root, gateAsking("3,warning,,ask-user," + text + "," + asks))
      expect((await run(listTasks(root))).at(0)?.parked?.questions.at(0)?.asks).toBe(asks)
      const heard: Array<DeciderRequest> = []
      const decided = await decideAll(root, heard)
      expect(heard.length).toBe(0)
      const verdict = decided.at(0)?.verdict
      expect(verdict?.kind).toBe("escalated")
      expect(verdict?.kind === "escalated" ? verdict.reason : "").toContain("asks the owner to " + named)
      expect((await run(openItems(root))).map((entry) => entry.item.owner)).toEqual(["user"])
    })
  })

  test("an action orc does not know goes to the owner", async () => {
    await withStartedTask(async (root) => {
      await parkThroughGate(root, gateAsking("question-1,warning,,ask-user,Is this branch ready?,unknown"))
      const heard: Array<DeciderRequest> = []
      const decided = await decideAll(root, heard)
      expect(heard.length).toBe(0)
      expect(decided.map((entry) => entry.verdict.kind)).toEqual(["escalated"])
    })
  })

  test("a question that names no action falls back to the guarded words", async () => {
    await withStartedTask(async (root) => {
      await parkThroughGate(root, gateAsking("question-1,info,,,ask-user,Merge this branch now?", "id,severity,file,line,action,description"))
      const heard: Array<DeciderRequest> = []
      const decided = await decideAll(root, heard)
      expect(heard.length).toBe(0)
      const verdict = decided.at(0)?.verdict
      expect(verdict?.kind === "escalated" ? verdict.reason : "").toContain("about merging")
    })
  })

  test("a live run's asking file carries the action to the decider", async () => {
    await withStartedTask(async (root) => {
      const runDir = await mkdtemp(join(tmpdir(), "orc-decider-asks-live-"))
      try {
        const wait = waitForAnswers(runDir, 30, "the gate")([{ id: "question-1", description: "Is this branch ready?", asks: "merge" }])
        const fiber = Effect.runFork(wait.pipe(Effect.provide(BunServices.layer)))
        try {
          const raw = await readAskingRaw(runDir, Date.now() + 5000)
          const asking = Schema.decodeUnknownSync(Schema.fromJsonString(Asking))(raw)
          expect(asking.questions.map((question) => question.asks)).toEqual(["merge"])
          assert.ok(Arr.isReadonlyArrayNonEmpty(asking.questions))
          await run(askStartedTask(root, "orc-1", { asked: asking.asked, questions: asking.questions }))
          const heard: Array<DeciderRequest> = []
          const decided = await decideAll(root, heard)
          expect(heard.length).toBe(0)
          expect(decided.map((entry) => entry.verdict.kind)).toEqual(["escalated"])
        } finally {
          await Effect.runPromise(Fiber.interrupt(fiber))
        }
      } finally {
        await rm(runDir, { recursive: true, force: true })
      }
    })
  })
})
