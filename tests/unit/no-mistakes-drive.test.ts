import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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
      const taskFile = join(dir, "task.md")
      await writeFile(taskFile, "# Retry the upload\n")
      const record = await Effect.runPromise(driveNoMistakes({ runner, taskFile, runDir: dir, allow, answers, ...waiting }).pipe(Effect.provide(BunServices.layer)))
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
      return Effect.succeed({ asked, answers: [{ question: "r2", answer: "Keep the old behavior" }] })
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
      return Effect.succeed(waited === 1 ? { asked, answers: [{ question: "r2", answer: "Keep the old behavior" }] } : { asked: "2026-11-02T10:40:00.000Z", answers: [] })
    }
    const { record } = await driveIn(answering, [], [], wait)
    expect(sent).toMatchObject([{ kind: "fix", ids: ["r1", "r2"] }])
    expect(sent.length).toBe(1)
    expect(record.openQuestions).toEqual([{ id: "r2", text: "changes product behavior", asked: "2026-11-02T10:40:00.000Z" }])
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
    const { record } = await driveIn(asking, [], [], () => Effect.succeed({ asked, answers: [] }))
    expect(sent).toEqual([])
    expect(record.openQuestions).toEqual([{ id: "r2", text: "changes product behavior", asked }])
  })

  test("a finding with an action orc does not know parks as an open question instead of failing the run", async () => {
    const manual = parked.replace("r2,error,b.go,,ask-user,changes product behavior", "r2,error,b.go,,manual,needs a human")
    const asking: NoMistakesRunner = { ...endedFailed, start: () => Effect.succeed({ stdout: manual, stderr: "", exitCode: 0 }) }
    const { record } = await driveIn(asking)
    expect(record.status).toBe("refused")
    expect(record.openQuestions).toEqual([{ id: "r2", text: "needs a human" }])
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

  test("reaching the gate cap parks the task with the cap as an open question instead of failing it", async () => {
    const sent: Array<GateResponse> = []
    const { record } = await driveIn(endlessGates(sent, 100))
    expect(sent.length).toBe(20)
    expect(record.status).toBe("refused")
    expect(record.openQuestions.map((question) => question.id)).toEqual(["gate-cap"])
    expect(record.openQuestions[0]?.text).toContain("20 no-mistakes gates")
  })

  test("an answer to the gate cap lets orc answer more gates at the same run", async () => {
    const sent: Array<GateResponse> = []
    const waitedOn: Array<ReadonlyArray<string>> = []
    const wait: Wait = (missing) => {
      waitedOn.push(missing.map((finding) => finding.id))
      return Effect.succeed({ asked, answers: [{ question: "gate-cap", answer: "keep going" }] })
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
