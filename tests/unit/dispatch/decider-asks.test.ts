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
import { openQuestions } from "../../lib/open-questions-2026-11-25"
import { guardReason, neverDecidedReason } from "../../../packages/run/src/features/decider/decider-guard"

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
  init: Effect.die("the repository is initialized in this test"),
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

const parkWithRunner = async (root: string, runner: NoMistakesRunner): Promise<void> => {
  const runDir = await mkdtemp(join(tmpdir(), "orc-decider-asks-run-"))
  try {
    const record = await run(driveNoMistakes({ runner, taskFile: "/task.md", runDir }))
    assert.ok(Arr.isReadonlyArrayNonEmpty(record.openQuestions))
    await run(parkStartedTask(root, "orc-1", "orc/orc-1", record.openQuestions, "2026-11-02T10:35:00.000Z"))
  } finally {
    await rm(runDir, { recursive: true, force: true })
  }
}

const parkThroughGate = (root: string, stdout: string): Promise<void> => parkWithRunner(root, parkedAt(stdout))

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

describe("Orc-authored question routing", () => {
  test.each([
    ["push", "escalated", 0],
    ["review", "answered", 1]
  ] as const)("a gate cap at %s retains topic routing instead of bypassing the guard", async (step, verdict, calls) => {
    await withStartedTask(async (root) => {
      const stdout = gateAsking("3,warning,,auto-fix,Retry the upload.,none").replace("gate: review", "gate: " + step)
      let responses = 0
      const runner: NoMistakesRunner = {
        ...parkedAt(stdout),
        respond: () => Effect.sync(() => {
          responses += 1
          return { stdout, stderr: "", exitCode: 0 }
        })
      }
      await parkWithRunner(root, runner)
      expect(responses).toBe(20)
      const question = (await run(listTasks(root))).at(0)?.parked?.questions.at(0)
      expect(question).toMatchObject({ id: "gate-cap" })
      if (step === "push" && question !== undefined) {
        expect(guardReason(question, "review-finding")).toBeNull()
      }
      const heard: Array<DeciderRequest> = []
      const decided = await decideAll(root, heard)
      expect(heard).toHaveLength(calls)
      expect(decided.map((entry) => entry.verdict.kind)).toEqual([verdict])
      if (step === "push") {
        expect(decided.at(0)?.verdict).toMatchObject({ kind: "escalated", reason: expect.stringContaining("about pushing") })
        expect((await run(openItems(root))).map((entry) => entry.item.owner)).toEqual(["user"])
        expect((await run(listTasks(root))).at(0)?.parked?.questions.at(0)?.answer).toBeNull()
      }
    })
  })

  test.each([
    ["release check pending", "escalated", 0],
    ["unit check pending", "answered", 1]
  ] as const)("a CI-waiting question with %s retains topic routing instead of becoming a finding", async (reason, verdict, calls) => {
    await withStartedTask(async (root) => {
      await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{
        id: "ci-waiting",
        text: "GitHub CI has not finished on abc123 for https://github.com/owner/repo/pull/1: " + reason + ". The PR stays open while the run waits on CI."
      }], "2026-11-02T10:35:00.000Z"))
      const heard: Array<DeciderRequest> = []
      const decided = await decideAll(root, heard)
      expect(heard).toHaveLength(calls)
      expect(decided.map((entry) => entry.verdict.kind)).toEqual([verdict])
      if (verdict === "escalated") {
        expect(decided.at(0)?.verdict).toMatchObject({ kind: "escalated", reason: expect.stringContaining("about releasing") })
        expect((await run(openItems(root))).map((entry) => entry.item.owner)).toEqual(["user"])
      }
    })
  })
})

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

  test("an unrecognized question action reaches the owner instead of the decider", async () => {
    await withStartedTask(async (root) => {
      await parkThroughGate(root, gateAsking("question-1,warning,,ask-user,Is this branch ready?,inspect"))
      const heard: Array<DeciderRequest> = []
      const decided = await decideAll(root, heard)
      expect(heard).toHaveLength(0)
      const verdict = decided.at(0)?.verdict
      expect(verdict?.kind === "escalated" ? verdict.reason : "").toContain("which orc does not know")
      expect((await run(openItems(root))).map((entry) => entry.item.owner)).toEqual(["user"])
    })
  })

  test("a routine question no-mistakes left unclassified reaches the decider, instead of the owner", async () => {
    await withStartedTask(async (root) => {
      await parkThroughGate(root, gateAsking("question-1,warning,,ask-user," + JSON.stringify(openQuestions.finishedRunTestUsesFailedPath.text) + ",unknown"))
      expect((await run(listTasks(root))).at(0)?.parked?.questions.at(0)?.asks).toBe("unknown")
      const heard: Array<DeciderRequest> = []
      const decided = await decideAll(root, heard)
      expect(heard.length).toBe(1)
      expect(decided.map((entry) => entry.verdict.kind)).toEqual(["answered"])
    })
  })

  test("an unclassified merge question reaches the owner instead of bypassing the text check", async () => {
    await withStartedTask(async (root) => {
      await parkThroughGate(root, gateAsking("question-1,warning,,ask-user,Merge this branch now?,unknown"))
      const heard: Array<DeciderRequest> = []
      const decided = await decideAll(root, heard)
      expect(heard).toHaveLength(0)
      const verdict = decided.at(0)?.verdict
      expect(verdict?.kind === "escalated" ? verdict.reason : "").toContain("about merging")
      expect((await run(openItems(root))).map((entry) => entry.item.owner)).toEqual(["user"])
    })
  })

  test("an omitted review question reports missing text instead of inventing why it needs the owner", async () => {
    await withStartedTask(async (root) => {
      await parkThroughGate(root, "run:\n  id: 01RUN\n  status: awaiting_approval\nreview-questions-omitted: 1 further review question(s) are open and have no row of their own. Omitted question ids: question-5\ngate: review")
      const heard: Array<DeciderRequest> = []
      const decided = await decideAll(root, heard)
      const verdict = decided.at(0)?.verdict
      expect(heard).toHaveLength(0)
      expect(verdict?.kind).toBe("escalated")
      expect(verdict?.kind === "escalated" ? verdict.reason : "").toContain("no-mistakes omitted the question text")
      expect((await run(openItems(root))).map((entry) => entry.item.owner)).toEqual(["user"])
    })
  })

  test("an omitted review question reaches the owner instead of receiving an answer without text", async () => {
    await withStartedTask(async (root) => {
      await parkThroughGate(root, "run:\n  id: 01RUN\n  status: awaiting_approval\nreview-questions-omitted: question-5\ngate: review")
      expect((await run(listTasks(root))).at(0)?.parked?.questions.at(0)).toMatchObject({ id: "question-5", text: "", asks: "unknown" })
      const heard: Array<DeciderRequest> = []
      const decided = await decideAll(root, heard)
      expect(heard).toHaveLength(0)
      const verdict = decided.at(0)?.verdict
      expect(verdict?.kind === "escalated" ? verdict.reason : "").toContain("carries no words")
      expect((await run(openItems(root))).map((entry) => entry.item.owner)).toEqual(["user"])
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

  test.each([
    "The normal send-back path deletes the terminal result before the App can show it. Preserve the existing optional merge record when constructing both closed states.",
    "A beat can therefore erase the result before the next App poll. Preserve the existing optional merge record when constructing both closed states.",
    "The step selection is accepted at packages/herdr-app/mods/orc-agents/main.ts:270-272, but this return always replaces its output with the merge note.",
    "After a conflict or red check sends a task back, the next beat can fail to spawn the start command or write its token before the App's completion refresh reads the backlog. The closed state constructed at packages/run/src/widgets/beat/beat.ts:143 discards merge, so JSON returns merge:null and the App shows the raw refusal again."
  ])("a finding reaches the decider instead of routing its code description to the owner: %s", async (description) => {
    expect(neverDecidedReason(description)).not.toBeNull()
    await withStartedTask(async (root) => {
      await parkThroughGate(root, gateAsking("3,warning,,ask-user," + JSON.stringify(description), "id,severity,file,action,description"))
      const heard: Array<DeciderRequest> = []
      const decided = await decideAll(root, heard)
      expect(heard).toHaveLength(1)
      expect(decided.map((entry) => entry.verdict.kind)).toEqual(["answered"])
    })
  })

  test.each([
    "inspect",
    "go-public",
    "share",
    "merge the PR",
    "delete the branch",
    "delete files outside the task",
    "log in",
    "publish the release",
    "push the branch",
    "make the repository public",
    "spend money",
    "change the privacy policy",
    "change the screenshot",
    "rotate the access token",
    "change security",
    "make it irreversible"
  ])("a finding with unrecognized action %s reaches the owner instead of the decider", async (action) => {
    await withStartedTask(async (root) => {
      await parkThroughGate(root, gateAsking("3,warning,,ask-user,Choose the next step.," + action))
      const heard: Array<DeciderRequest> = []
      const decided = await decideAll(root, heard)
      expect(heard).toHaveLength(0)
      const verdict = decided.at(0)?.verdict
      expect(verdict?.kind === "escalated" ? verdict.reason : "").toContain("which orc does not know")
      expect((await run(openItems(root))).map((entry) => entry.item.owner)).toEqual(["user"])
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
