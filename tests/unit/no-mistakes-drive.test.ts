import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import type { GateResponse, QuestionAnswer } from "../../packages/run/src/entities/review-gate/no-mistakes-gate"
import { askUserWord, driveNoMistakes, type AllowWord, type NoMistakesFinding, type NoMistakesRecord, type NoMistakesRunner } from "../../packages/run/src/entities/review-gate/no-mistakes"
import type { WaitResult } from "../../packages/run/src/entities/review-gate/answer-wait"
import { parked } from "../lib/no-mistakes-fixture"

// The failed run no-mistakes printed for run 01M5EH9DXNBCAYWRHSF7VM1480, with the step table cut to the step that failed.
const failedRun = [
  "run:",
  "  id: \"01M5EH9DXNBCAYWRHSF7VM1480\"",
  "  branch: fm/orc-dash-captain-log",
  "  status: failed",
  "  steps[2]{step,status,findings,duration_ms}:",
  "    test,completed,0,582251",
  "    lint,failed,12,963128",
  "outcome: failed",
  "error: \"step lint failed: agent lint: pi output parse: invalid character '.' looking for beginning of object key string\""
].join("\n")

// The lint findings no-mistakes printed for that run, cut to the first.
const failedRunLogs = [
  "step: lint",
  "run: \"01M5EH9DXNBCAYWRHSF7VM1480\"",
  "findings[1]{id,severity,file,action,description}:",
  "  lint-1,warning,packages/dashboard/src/ledger.ts,ask-user,ledgerGroups exceeds cognitive complexity 15 with 18"
].join("\n")

const endedFailed: NoMistakesRunner = {
  init: Effect.die("the repository is initialized in this test"),
  start: () => Effect.succeed({ stdout: failedRun, stderr: "", exitCode: 0 }),
  reattach: Effect.succeed({ stdout: failedRun, stderr: "", exitCode: 0 }),
  respond: () => Effect.die("no gate is parked"),
  answer: () => Effect.die("no question is open"),
  status: () => Effect.succeed({ stdout: failedRun, stderr: "", exitCode: 0 }),
  logs: () => Effect.succeed({ stdout: failedRunLogs, stderr: "", exitCode: 0 })
}

// What no-mistakes v1.100.2 printed for a run pushed to an origin with no PR provider.
const skippedPr = [
  "id: \"01M5QDS73AKNTMFA0F0V3BCX24\"",
  "branch: orc/greet-world",
  "status: completed",
  "findings: none",
  "steps[9]{step,status,findings,duration_ms}:",
  "  intent,completed,0,0",
  "  rebase,completed,0,320",
  "  review,completed,0,19171",
  "  test,completed,0,27824",
  "  document,completed,0,17349",
  "  lint,completed,0,102",
  "  push,completed,0,436",
  "  pr,skipped,0,13",
  "  ci,skipped,0,12",
  "automatic_skips[2]{step,reason}:",
  "  pr,provider unknown is not supported yet",
  "  ci,provider unknown is not supported yet",
  "outcome: passed-with-skips"
].join("\n")

const endedSkippingPr: NoMistakesRunner = {
  ...endedFailed,
  start: () => Effect.succeed({ stdout: skippedPr, stderr: "", exitCode: 0 }),
  status: () => Effect.succeed({ stdout: skippedPr, stderr: "", exitCode: 0 }),
  logs: () => Effect.succeed({ stdout: "findings: none", stderr: "", exitCode: 0 })
}

describe("driveNoMistakes", () => {
  type Wait = (missing: ReadonlyArray<NoMistakesFinding>) => Effect.Effect<WaitResult>
  const asked = "2026-11-02T10:20:00.000Z"
  const driveIn = async (
    runner: NoMistakesRunner,
    allow: ReadonlyArray<AllowWord> = [],
    answers: ReadonlyArray<QuestionAnswer> = [],
    waitForAnswers?: Wait
  ): Promise<{ readonly record: NoMistakesRecord; readonly gate: string }> => {
    const dir = await mkdtemp(join(tmpdir(), "orc-gate-"))
    try {
      const waiting = waitForAnswers === undefined ? {} : { waitForAnswers }
      const record = await Effect.runPromise(driveNoMistakes({ runner, taskFile: "/task.md", runDir: dir, allow, answers, ...waiting }).pipe(Effect.provide(BunServices.layer)))
      return { record, gate: await readFile(join(dir, "gate.log"), "utf8") }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  const gateSteps = (gate: string): ReadonlyArray<string | undefined> => gate.trim().split("\n").map((line) => line.split(" ").at(-1))

  test("a run that skips the pr step carries the reason no-mistakes gave", async () => {
    const { record } = await driveIn(endedSkippingPr)
    expect(record.result).toBe("no-mistakes ended with outcome passed-with-skips, and it skipped the pr step: provider unknown is not supported yet. No PR opens.")
  })

  const notInitialized = { stdout: "error: repo not initialized (run 'no-mistakes init' first)\nhelp[1]: Run `no-mistakes init` to set up the gate in this repository", stderr: "", exitCode: 1 }

  const initThenStart = (calls: Array<string>, starts: ReadonlyArray<typeof notInitialized | null>, initExit = 0): NoMistakesRunner => ({
    ...endedSkippingPr,
    init: Effect.sync(() => {
      calls.push("init")
      return { stdout: "", stderr: initExit === 0 ? "" : "init: not a git repository", exitCode: initExit }
    }),
    start: () => Effect.sync(() => {
      const reply = starts[calls.filter((call) => call === "start").length] ?? null
      calls.push("start")
      return reply ?? { stdout: skippedPr, stderr: "", exitCode: 0 }
    })
  })

  test("a repository not initialized for no-mistakes is initialized and the run starts again, instead of dying for the owner", async () => {
    const calls: Array<string> = []
    const { record, gate } = await driveIn(initThenStart(calls, [notInitialized]))
    expect(calls).toEqual(["start", "init", "start"])
    expect(gateSteps(gate)).toEqual(["start", "init"])
    expect(record.result).toBe("no-mistakes ended with outcome passed-with-skips, and it skipped the pr step: provider unknown is not supported yet. No PR opens.")
  })

  test("a repository still not initialized after init ends the run once, instead of initializing again and again", async () => {
    const calls: Array<string> = []
    const { record } = await driveIn(initThenStart(calls, [notInitialized, notInitialized, notInitialized]))
    expect(calls).toEqual(["start", "init", "start"])
    expect(record.result).toBe("no-mistakes refused to start: repo not initialized (run 'no-mistakes init' first). No PR opens.")
  })

  test("an init that fails ends the run with the init's own reason, instead of starting again without it", async () => {
    const calls: Array<string> = []
    const { record } = await driveIn(initThenStart(calls, [notInitialized], 1))
    expect(calls).toEqual(["start", "init"])
    expect(record.result).toBe("no-mistakes refused to start: no-mistakes init failed: init: not a git repository. No PR opens.")
  })

  test("a run that ends failed carries the error no-mistakes gave for it", async () => {
    const { record } = await driveIn(endedFailed)
    expect(record.status).toBe("failed")
    expect(record.result).toBe("no-mistakes ended with outcome failed: step lint failed: agent lint: pi output parse: invalid character '.' looking for beginning of object key string. No PR opens.")
  })

  test("the error of a failed run beside its steps table still lets orc read the recorded findings", async () => {
    const { record } = await driveIn(endedFailed)
    expect(record.findings.map((finding) => finding.id)).toEqual(["lint-1"])
  })

  test("a parked gate leaves its step in the run folder instead of only in memory", async () => {
    const parkedRunner: NoMistakesRunner = { ...endedFailed, start: () => Effect.succeed({ stdout: parked, stderr: "", exitCode: 0 }) }
    const { gate } = await driveIn(parkedRunner)
    expect(gateSteps(gate)).toEqual(["start", "review"])
  })

  test("a gate that parks at the same step twice leaves two lines instead of one", async () => {
    let answered = false
    const repark: NoMistakesRunner = {
      ...endedFailed,
      start: () => Effect.succeed({ stdout: parked, stderr: "", exitCode: 0 }),
      respond: () => {
        if (answered) {
          return Effect.succeed({ stdout: failedRun, stderr: "", exitCode: 0 })
        }
        answered = true
        return Effect.succeed({ stdout: parked, stderr: "", exitCode: 0 })
      }
    }
    const { gate } = await driveIn(repark, [askUserWord])
    expect(gateSteps(gate)).toEqual(["start", "review", "review"])
  })

  test("an unanswered ask-user finding stops as an open question with its text instead of a refusal with none", async () => {
    const asking: NoMistakesRunner = { ...endedFailed, start: () => Effect.succeed({ stdout: parked, stderr: "", exitCode: 0 }) }
    const { record } = await driveIn(asking)
    expect(record.status).toBe("refused")
    expect(record.openQuestions).toEqual([{ id: "r2", text: "changes product behavior" }])
    expect(record.result).toContain("--answer r2=")
  })

  test("an answered ask-user finding is sent as a fix carrying the answer instead of stopping the run", async () => {
    const sent: Array<GateResponse> = []
    const answering: NoMistakesRunner = {
      ...endedFailed,
      start: () => Effect.succeed({ stdout: parked, stderr: "", exitCode: 0 }),
      respond: (response) => {
        sent.push(response)
        return Effect.succeed({ stdout: failedRun, stderr: "", exitCode: 0 })
      }
    }
    const { record } = await driveIn(answering, [], [{ question: "r2", answer: "Keep the old behavior" }])
    expect(record.openQuestions).toEqual([])
    expect(sent).toMatchObject([{ kind: "fix", ids: ["r1", "r2"], instructions: "The captain answered these findings; fix each as the answer says:\nr2: Keep the old behavior" }])
  })

  test("a fix converted to follow-ups does not report the captain's answer as applied", async () => {
    const sent: Array<GateResponse> = []
    const fixReview = parked.replace("awaiting_approval", "fix_review").replace("r2,error", "r2,info")
    const deferred = [
      "recorded:",
      "  fixed[0]:",
      "  ignored[0]:",
      "  kept[0]:",
      "  follow_ups[2]: r1,r2",
      skippedPr.replace("review,completed,0", "review,completed,2")
    ].join("\n")
    const runner: NoMistakesRunner = {
      ...endedSkippingPr,
      start: () => Effect.succeed({ stdout: fixReview, stderr: "", exitCode: 0 }),
      respond: (response) => {
        sent.push(response)
        return Effect.succeed({ stdout: deferred, stderr: "", exitCode: 0 })
      },
      status: () => Effect.succeed({ stdout: skippedPr.replace("review,completed,0", "review,completed,2"), stderr: "", exitCode: 0 }),
      logs: () => Effect.succeed({ stdout: fixReview, stderr: "", exitCode: 0 })
    }
    const { record, gate } = await driveIn(runner, [], [{ question: "r2", answer: "Keep the old behavior" }])
    expect(sent).toMatchObject([{ kind: "fix", ids: ["r1", "r2"], instructions: expect.stringContaining("r2: Keep the old behavior") }])
    expect(record).toMatchObject({ deferredFindingIds: ["r1", "r2"] })
    expect(gate).toContain("deferred to PR follow-ups: r1, r2")
    expect(record.result).toContain("no-mistakes ran no fix round at that gate.")
    expect(record.result).toContain("The captain's answer for r2 was not applied.")
  })

  test("a mixed fix keeps the deferred answer without claiming that no fixer ran", async () => {
    const sent: Array<GateResponse> = []
    const fixReview = parked.replace("awaiting_approval", "fix_review").replace("r1,warning,a.go,,auto-fix", "r1,warning,a.go,,ask-user")
    const warningOnly = fixReview.split("\n").filter((line) => !line.trimStart().startsWith("r2,")).join("\n").replace("findings[2]", "findings[1]")
    const runner: NoMistakesRunner = {
      ...endedSkippingPr,
      start: () => Effect.succeed({ stdout: fixReview, stderr: "", exitCode: 0 }),
      respond: (response) => {
        sent.push(response)
        const stdout = sent.length === 1
          ? ["recorded:", "  sent_to_fixer[1]: r2", "  ignored[0]:", "  kept[0]:", "  follow_ups[1]: r1", warningOnly].join("\n")
          : skippedPr
        return Effect.succeed({ stdout, stderr: "", exitCode: 0 })
      }
    }
    const answers = [{ question: "r1", answer: "Keep the warning visible" }, { question: "r2", answer: "Fix the error" }]
    const { record } = await driveIn(runner, [], answers)
    expect(sent).toMatchObject([
      { kind: "fix", ids: ["r1", "r2"] },
      { kind: "fix", ids: ["r1"], instructions: expect.stringContaining("r1: Keep the warning visible") }
    ])
    expect(record.openQuestions).toEqual([])
    expect(record.result).not.toContain("no fix round")
    expect(record.result).toContain("The captain's answer for r1 was not applied.")
    expect(record.result).not.toContain("answer for r2")
  })

  test("an ask-user finding answered within the wait is sent at the same gate instead of ending the run", async () => {
    const sent: Array<GateResponse> = []
    const waitedOn: Array<ReadonlyArray<string>> = []
    const answering: NoMistakesRunner = {
      ...endedFailed,
      start: () => Effect.succeed({ stdout: parked, stderr: "", exitCode: 0 }),
      respond: (response) => {
        sent.push(response)
        return Effect.succeed({ stdout: failedRun, stderr: "", exitCode: 0 })
      }
    }
    const wait: Wait = (missing) => {
      waitedOn.push(missing.map((finding) => finding.id))
      return Effect.succeed({ asked, answers: [{ question: "r2", answer: "Keep the old behavior" }], askedAt: [{ question: "r2", asked }] })
    }
    const { record, gate } = await driveIn(answering, [], [], wait)
    expect(waitedOn).toEqual([["r2"]])
    expect(record.openQuestions).toEqual([])
    expect(sent).toMatchObject([{ kind: "fix", ids: ["r1", "r2"], instructions: "The captain answered these findings; fix each as the answer says:\nr2: Keep the old behavior" }])
    expect(gateSteps(gate)).toContain("asking")
  })

  test("a finding re-raised after its answer was sent is asked again instead of resent", async () => {
    const sent: Array<GateResponse> = []
    const answering: NoMistakesRunner = {
      ...endedFailed,
      start: () => Effect.succeed({ stdout: parked, stderr: "", exitCode: 0 }),
      respond: (response) => {
        sent.push(response)
        return Effect.succeed({ stdout: parked, stderr: "", exitCode: 0 })
      }
    }
    let waited = 0
    const wait: Wait = () => {
      waited += 1
      return Effect.succeed(
        waited === 1
          ? { asked, answers: [{ question: "r2", answer: "Keep the old behavior" }], askedAt: [{ question: "r2", asked }] }
          : { asked: "2026-11-02T10:40:00.000Z", answers: [], askedAt: [{ question: "r2", asked: "2026-11-02T10:40:00.000Z" }] }
      )
    }
    const { record } = await driveIn(answering, [], [], wait)
    expect(sent).toMatchObject([{ kind: "fix", ids: ["r1", "r2"] }])
    expect(sent.length).toBe(1)
    expect(record.openQuestions).toEqual([{ id: "r2", text: "changes product behavior", asked: "2026-11-02T10:40:00.000Z", asking: "2026-11-02T10:40:00.000Z" }])
  })

  test("a wait that runs out unanswered parks the question instead of sending an empty answer", async () => {
    const sent: Array<GateResponse> = []
    const asking: NoMistakesRunner = {
      ...endedFailed,
      start: () => Effect.succeed({ stdout: parked, stderr: "", exitCode: 0 }),
      respond: (response) => {
        sent.push(response)
        return Effect.succeed({ stdout: failedRun, stderr: "", exitCode: 0 })
      }
    }
    const { record } = await driveIn(asking, [], [], () => Effect.succeed({ asked, answers: [], askedAt: [{ question: "r2", asked }] }))
    expect(sent).toEqual([])
    expect(record.openQuestions).toEqual([{ id: "r2", text: "changes product behavior", asked, asking: asked }])
  })

  test("a finding with an action orc does not know parks as an open question instead of failing the run", async () => {
    const manual = parked.replace("r2,error,b.go,,ask-user,changes product behavior", "r2,error,b.go,,manual,needs a human")
    const asking: NoMistakesRunner = { ...endedFailed, start: () => Effect.succeed({ stdout: manual, stderr: "", exitCode: 0 }) }
    const { record } = await driveIn(asking)
    expect(record.status).toBe("refused")
    expect(record.openQuestions).toEqual([{ id: "r2", text: "needs a human", owner: "user" }])
    expect(record.result).toContain("--answer r2=")
  })

  const autoFixOnly = parked.replace("r2,error,b.go,,ask-user,changes product behavior", "r2,warning,b.go,,auto-fix,ignored error")
  const endlessGates = (sent: Array<GateResponse>, until: number): NoMistakesRunner => ({
    ...endedFailed,
    start: () => Effect.succeed({ stdout: autoFixOnly, stderr: "", exitCode: 0 }),
    respond: (response) => {
      sent.push(response)
      return Effect.succeed({ stdout: sent.length >= until ? failedRun : autoFixOnly, stderr: "", exitCode: 0 })
    }
  })

  test("reaching the gate cap parks for the decider instead of assigning the cap to the owner", async () => {
    const sent: Array<GateResponse> = []
    const { record } = await driveIn(endlessGates(sent, 100))
    expect(sent.length).toBe(20)
    expect(record.status).toBe("refused")
    expect(record.openQuestions.map((question) => question.id)).toEqual(["gate-cap"])
    expect(record.openQuestions.map((question) => question.owner ?? "decider")).toEqual(["decider"])
    expect(record.openQuestions[0]?.text).toContain("20 no-mistakes gates")
  })

  test("an answer to the gate cap lets orc answer more gates at the same run", async () => {
    const sent: Array<GateResponse> = []
    const waitedOn: Array<ReadonlyArray<string>> = []
    const wait: Wait = (missing) => {
      waitedOn.push(missing.map((finding) => finding.id))
      return Effect.succeed({ asked, answers: [{ question: "gate-cap", answer: "keep going" }], askedAt: [{ question: "gate-cap", asked }] })
    }
    const { record } = await driveIn(endlessGates(sent, 25), [], [], wait)
    expect(waitedOn).toEqual([["gate-cap"]])
    expect(sent.length).toBe(25)
    expect(record.openQuestions).toEqual([])
    expect(record.gatesAnswered).toBe(25)
  })

  test("a gate that answers without parking leaves a running line instead of silence", async () => {
    const waiting = [
      "run:",
      "  id: \"01RUN\"",
      "  branch: orc/test",
      "  status: running",
      "  head: abc1234",
      "  pr: \"\"",
      "  findings: none"
    ].join("\n")
    const waitingRunner: NoMistakesRunner = {
      ...endedFailed,
      start: () => Effect.succeed({ stdout: waiting, stderr: "", exitCode: 0 }),
      reattach: Effect.succeed({ stdout: parked, stderr: "", exitCode: 0 })
    }
    const { gate } = await driveIn(waitingRunner)
    expect(gateSteps(gate)).toEqual(["start", "running", "review"])
  })
})
