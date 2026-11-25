import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Array as Arr, Effect, Layer, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { addTask, claimTask, findTask, listTasks, writeTaken } from "../../packages/run/src/entities/backlog/index"
import { answerTask, askStartedTask, handAnswersToResume, parkStartedTask } from "../../packages/run/src/entities/parked-runs/index"
import { decideReviewQuestions, type AskDecider, type DeciderRequest } from "../../packages/run/src/features/decider/index"
import { askSetupFor } from "../../packages/run/src/entities/agent/index"
import { driveNoMistakes, type NoMistakesRecord, type NoMistakesReply, type NoMistakesRunner } from "../../packages/run/src/entities/review-gate/no-mistakes"
import { waitForAnswers } from "../../packages/run/src/entities/review-gate/answer-wait"
import { Asking } from "../../packages/run/src/entities/review-gate/index"
import { endingFromResult, readResultThrough } from "../../packages/run/src/features/queueing-a-task/index"
import type { GateResponse } from "../../packages/run/src/entities/review-gate/no-mistakes-gate"
import { openDatabase, openQuestionsForRun, recordRun, recordSignal, recordStep } from "../../packages/run/src/entities/run-history/index"
import { recordOpenAsks, recordOpenQuestion } from "../../packages/run/src/features/running-a-task/history-write"
import { openItems, routeTaskItems } from "../../packages/run/src/entities/attention/index"
import { runBeat } from "../../packages/run/src/widgets/beat/beat"
import { taskLabel } from "../../packages/run/src/shared/process/pueue-status"
import type { DispatchConfig, Project } from "../../packages/run/src/shared/config/dispatch-config"
import { quietSources } from "../lib/beat-sources"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const withDirs = async (body: (root: string, runs: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-parked-gate-"))
  const runs = await mkdtemp(join(tmpdir(), "orc-parked-runs-"))
  try {
    await body(root, runs)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(runs, { recursive: true, force: true })
  }
}

const spec = { title: "Fix the thing", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0 as const, created: "2026-11-18T09:00:00.000Z", body: "# Fix the thing\n" }

const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-11-18T10:00:00.000Z" }

const config: DispatchConfig = {
  machines: [{ name: "mac", slots: 1, start: ["orc", "runner", "start"] }],
  quota: { provider: "keyed", command: ["orc-quota"], accounts: [{ name: "main", kind: "token-file", tokenFile: "/secrets/main-token" }], floorPercent: 15 }
}

const projects: ReadonlyArray<Project> = [{ name: "orc", checkouts: { mac: "/checkout" } }]

const quotaReply = JSON.stringify({ schema: "orc.quota.v1", accounts: [{ name: "main", remainingPercent: 80 }] })

const heredoc = (body: string): string => ["cat <<'J'", body, "J"].join(String.fromCharCode(10))

const pueueStub = (statusJson: string): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner
    return ChildProcessSpawner.make((command) =>
      ChildProcess.isStandardCommand(command) && command.command === "pueue"
        ? real.spawn(ChildProcess.make("sh", ["-c", heredoc(statusJson)]))
        : ChildProcess.isStandardCommand(command) && command.command === "orc-quota"
          ? real.spawn(ChildProcess.make("sh", ["-c", heredoc(quotaReply)]))
          : real.spawn(command)
    )
  }))

const doneStatus = (root: string, start: string, end: string): string =>
  JSON.stringify({ tasks: { "11": { id: 11, label: taskLabel(root, "orc-1"), group: "orc", path: "/checkout", status: { Done: { start, end, result: { Failed: 3 } } } } } })

const answeringDecider = (rule: string, heard: Array<DeciderRequest>): AskDecider => ({
  home: "/nonexistent/orc-home",
  ask: (request) => {
    heard.push(request)
    return Effect.succeed(JSON.stringify({ decision: "answer", answer: "Table B", rule, reason: "the intent names it" }))
  }
})

const beatWith = (root: string, statusJson: string, sources = quietSources()) => {
  const spawner = pueueStub(statusJson).pipe(Layer.provide(BunServices.layer))
  return Effect.runPromise(runBeat(root, root, sources).pipe(Effect.provide(Layer.merge(BunServices.layer, spawner))))
}

const driveGate = async (runs: string, name: string, overrides: { start: string; respond?: (response: GateResponse) => Effect.Effect<NoMistakesReply>; answers: ReadonlyArray<{ question: string; answer: string }>; waitSeconds?: number }): Promise<NoMistakesRecord> => {
  await mkdir(join(runs, name), { recursive: true })
  return run(driveNoMistakes({ runner: runnerFor(overrides.start, overrides.respond), taskFile: runs + "/task.md", runDir: runs + "/" + name, answers: overrides.answers, waitForAnswers: overrides.waitSeconds === undefined ? () => Effect.succeed({ answers: [], asked: null, askedAt: [] }) : waitForAnswers(join(runs, name), overrides.waitSeconds, "no-mistakes") }))}

const parkedTable = (findings: ReadonlyArray<string>): string =>
  ["run:", "  status: awaiting_approval", "  awaiting_agent: parked 2m10s", "  head: abc1234", '  pr: ""', "  findings[" + findings.length.toString() + "]{id,severity,file,line,action,description}:", ...findings.map((row) => "    " + row), "gate: review"].join("\n")

const parkedA = parkedTable(["q1,warning,a.go,,ask-user,Which table?"])

const parkedB = parkedTable(["r1,error,b.go,,auto-fix,Fixable", "review-1,warning,,,manual,needs a human"])

const runnerFor = (start: string, respond?: (response: GateResponse) => Effect.Effect<NoMistakesReply>): NoMistakesRunner => ({
  init: Effect.die("the repository is initialized in this test"),
  start: () => Effect.succeed({ stdout: start, stderr: "", exitCode: 0 }),
  reattach: Effect.die("no reattach in this test"),
  respond: (response) => respond === undefined ? Effect.die("no gate answers in this test") : respond(response),
  answer: () => Effect.die("no open questions in this test"),
  status: () => Effect.die("no recorded findings in this test"),
  logs: () => Effect.die("no recorded findings in this test")
})

const dbOf = async (root: string) => run(openDatabase(root))

const readOpen = async (root: string, runId: string) => {
  const db = await dbOf(root)
  try {
    return await run(openQuestionsForRun(db, runId))
  } finally {
    db.close()
  }
}

const recordGateRun = async (root: string, runId: string, started: string, record: NoMistakesRecord, endReason: string): Promise<void> => {
  const db = await dbOf(root)
  try {
    await run(recordRun(db, { id: runId, project: "/checkout", branch: "orc/orc-1", taskFile: "orc-1.md", status: "failed", started, prLink: null, endReason }))
    const stepId = await run(recordStep(db, { runId, name: "no-mistakes", attempt: 1, status: "failed", started: record.started, ended: record.ended, agentFile: null, piSessionFile: null }))
    for (const question of record.openQuestions) {
      await run(recordSignal(db, { stepId, name: "open-question", value: JSON.stringify(question) }))
    }
  } finally {
    db.close()
  }
}

const startOrc1 = async (root: string, at: string): Promise<void> => {
  await writeFile(join(root, "dispatch.json"), JSON.stringify(config))
  await writeFile(join(root, "projects.json"), JSON.stringify({ projects }))
  await run(addTask(root, spec))
  await run(claimTask(root, "orc-1"))
  const first = (await run(listTasks(root))).find((task) => task.spec.id === "orc-1")
  if (first === undefined) {
    throw new Error("the backlog holds no orc-1")
  }
  await run(writeTaken(root, { spec: first.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at, log: root + "/logs/orc-1.log" } } }))
}

const restartOrc1 = async (root: string, beat: string, at: string): Promise<void> => {
  const orc1 = (await run(listTasks(root))).find((task) => task.spec.id === "orc-1")
  if (orc1 === undefined || orc1.state.kind === "closed") {
    throw new Error("orc-1 is not parked")
  }
  await run(claimTask(root, "orc-1"))
  await run(writeTaken(root, { ...handAnswersToResume(orc1), state: { kind: "started", claim: { ...claim, beat, takenAt: at }, started: { at, log: root + "/logs/orc-1.log" } } }))
}

const answersOf = async (root: string): Promise<Array<{ question: string; answer: string }>> => {
  const record = await run(findTask(root, "orc-1"))
  return (record.parked?.questions ?? []).flatMap((question) =>
    question.answer === null ? [] : [{ question: question.id, answer: question.answer.words }]).toSorted((left, right) => left.question < right.question ? -1 : 1)
}

const openReviewItems = async (root: string) =>
  (await run(openItems(root))).map((entry) => entry.item).filter((item) => item.kind === "review-question" && item.task === "orc-1" && item.state.kind === "open")

const actionKinds = (actions: ReadonlyArray<{ kind: string; task?: string }>): ReadonlyArray<string> =>
  actions.map((action) => action.kind + ":" + (action.task ?? ""))

describe("a run parked on a gate orc cannot answer", () => {
  test("an unchanged gate parks the resumed run instead of restarting it, and the gate is reported once", async () => {
    await withDirs(async (root, runs) => {
      const runA = await driveGate(runs, "run-1", { start: parkedA, answers: [] })
      expect(runA.result).toContain("Which table?")
      await recordGateRun(root, "run-1", "2026-11-18T10:00:00.000Z", runA, runA.result)
      await startOrc1(root, "2026-11-18T10:00:00.000Z")
      const firstBeat = await beatWith(root, doneStatus(root, "2026-11-18T10:00:00.000Z", "2026-11-18T10:01:00.000Z"))
      expect(actionKinds(firstBeat.actions)).toContain("parked:orc-1")
      expect((await run(findTask(root, "orc-1"))).parked?.questions.map((question) => question.id)).toEqual(["q1"])
      await run(answerTask(root, "orc-1", "q1=Table B", "2026-11-18T10:02:00.000Z"))
      const answersB = await answersOf(root)
      expect(answersB).toEqual([{ question: "q1", answer: "Table B" }])
      const priorOpen = await readOpen(root, "run-1")
      expect(priorOpen.map((question) => question.id)).toEqual(["q1"])
      const setup = askSetupFor(runs + "/run-2", runs + "/run-2-session", 30, answersB, priorOpen)
      const runB = await driveGate(runs, "run-2", { start: parkedB, answers: answersB })
      expect(runB.openQuestions).toEqual([{ id: "review-1", text: "needs a human", owner: "user" }])
      await recordGateRun(root, "run-2", "2026-11-18T10:03:00.000Z", runB, runB.result)
      const db = await dbOf(root)
      try {
        await run(recordStep(db, { runId: "run-2", name: "implement", attempt: 1, status: "passed", started: "2026-11-18T10:03:00.000Z", ended: "2026-11-18T10:03:00.000Z", agentFile: null, piSessionFile: null }))
        await run(recordOpenAsks((step, question) => recordOpenQuestion(db, "run-2", step, question), setup, { name: "implement", attempt: 1 }, []))
      } finally {
        db.close()
      }
      expect((await readOpen(root, "run-2")).map((question) => question.id)).toEqual(["review-1"])
      await restartOrc1(root, "beat-2", "2026-11-18T10:03:00.000Z")
      const heard: Array<DeciderRequest> = []
      const sources = { ...quietSources(), askDecider: answeringDecider("# Fix the thing", heard) }
      const first = await beatWith(root, doneStatus(root, "2026-11-18T10:02:00.000Z", "2026-11-18T10:05:00.000Z"), sources)
      expect((await run(listTasks(root))).map((task) => task.spec.id + ":" + task.state.kind)).toEqual(["orc-1:new"])
      expect(actionKinds(first.actions)).toContain("parked:orc-1")
      const parked = await run(findTask(root, "orc-1"))
      expect(parked.parked?.origin?.run).toEqual("run-2")
      expect(parked.parked?.questions.map((question) => question.id)).toEqual(["review-1"])
      const reported = await openReviewItems(root)
      expect(reported).toHaveLength(1)
      const later = await beatWith(root, doneStatus(root, "2026-11-18T10:02:00.000Z", "2026-11-18T10:05:00.000Z"), sources)
      const kinds = actionKinds(later.actions)
      expect(kinds).toContain("waits:orc-1")
      expect(kinds.filter((kind) => kind === "started:orc-1")).toEqual([])
      const reason = later.actions.flatMap((action) => action.kind === "waits" && action.task === "orc-1" ? [action.reason] : [])
      expect(reason).toEqual(["parked on orc/orc-1 for the captain's answer to review-1"])
      expect(heard).toEqual([])
      expect(await openReviewItems(root)).toEqual(reported)
    })
  })

  test("an answered question is not carried into the resumed run", async () => {
    await withDirs(async (root, runs) => {
      const runA = await driveGate(runs, "run-1", { start: parkedA, answers: [] })
      await recordGateRun(root, "run-1", "2026-11-18T10:00:00.000Z", runA, runA.result)
      const priorOpen = await readOpen(root, "run-1")
      expect(priorOpen.map((question) => question.id)).toEqual(["q1"])
      const setup = askSetupFor(runs + "/run-2", runs + "/run-2-session", 30, [{ question: "q1", answer: "Table B" }], priorOpen)
      expect(setup.priorOpen).toEqual([])
      await Effect.runPromise(recordOpenAsks(() => Effect.succeed(true), setup, { name: "implement", attempt: 1 }, []).pipe(Effect.provide(BunServices.layer)))
      expect([...setup.state.recorded]).toEqual([])
    })
  })

  test("an answered owner finding beside an auto-fix finding is sent as one fix instead of refusing the gate", async () => {
    await withDirs(async (root, runs) => {
      const responses: Array<GateResponse> = []
      const runA = await driveGate(runs, "run-1", { start: parkedA, answers: [] })
      await recordGateRun(root, "run-1", "2026-11-18T10:00:00.000Z", runA, runA.result)
      await startOrc1(root, "2026-11-18T10:00:00.000Z")
      await beatWith(root, doneStatus(root, "2026-11-18T10:00:00.000Z", "2026-11-18T10:01:00.000Z"))
      await run(answerTask(root, "orc-1", "q1=Table B", "2026-11-18T10:02:00.000Z"))
      const runB = await driveGate(runs, "run-2", { start: parkedB, answers: await answersOf(root) })
      await recordGateRun(root, "run-2", "2026-11-18T10:03:00.000Z", runB, runB.result)
      await restartOrc1(root, "beat-2", "2026-11-18T10:03:00.000Z")
      const parkedBeat = await beatWith(root, doneStatus(root, "2026-11-18T10:02:00.000Z", "2026-11-18T10:05:00.000Z"))
      expect(actionKinds(parkedBeat.actions)).toContain("parked:orc-1")
      await run(answerTask(root, "orc-1", "review-1=Keep it", "2026-11-18T10:06:00.000Z"))
      const answersC = await answersOf(root)
      expect(answersC).toEqual([{ question: "review-1", answer: "Keep it" }])
      const reraised = (table: string) => (response: GateResponse) =>
        Effect.sync(() => {
          responses.push(response)
          const covered = new Set([...(response.kind === "fix" ? response.ids : []), ...(response.kind === "fix" ? response.ignore : [])])
          return response.kind === "fix" && covered.has("review-1")
            ? { stdout: table, stderr: "", exitCode: 0 }
            : { stdout: 'error: "finding review-1 is undecided"', stderr: "", exitCode: 1 }
        })
      const runC = await driveGate(runs, "run-3", { start: parkedB, respond: reraised(parkedB), answers: answersC })
      expect(responses).toEqual([{
        kind: "fix",
        ids: ["r1", "review-1"],
        ignore: [],
        instructions: "The captain answered these findings; fix each as the answer says:\nreview-1: Keep it"
      }])
      expect(runC.status).toEqual("refused")
      expect(runC.openQuestions).toEqual([{ id: "review-1", text: "needs a human", owner: "user" }])
    })
  })

  test("an answered owner finding alone is sent as a fix carrying the owner's words instead of refusing the gate", async () => {
    await withDirs(async (_root, runs) => {
      const responses: Array<GateResponse> = []
      const table = parkedTable(["review-1,warning,,,manual,needs a human"])
      const reraising = (response: GateResponse) =>
        Effect.sync(() => {
          responses.push(response)
          return { stdout: table, stderr: "", exitCode: 0 }
        })
      const record = await driveGate(runs, "run-9", { start: table, respond: reraising, answers: [{ question: "review-1", answer: "Keep it" }] })
      expect(responses).toEqual([{
        kind: "fix",
        ids: ["review-1"],
        ignore: [],
        instructions: "The captain answered these findings; fix each as the answer says:\nreview-1: Keep it"
      }])
      expect(record.status).toEqual("refused")
      expect(record.openQuestions).toEqual([{ id: "review-1", text: "needs a human", owner: "user" }])
    })
  })

  test("a decider answer to a finding orc cannot answer leaves the gate waiting for the owner", async () => {
    const control = await mkdtemp(join(tmpdir(), "orc-owner-control-"))
    try {
      await run(addTask(control, { ...spec, body: "# Fix the thing\n" }))
      await run(claimTask(control, "orc-1"))
      const taken = (await run(listTasks(control))).find((task) => task.spec.id === "orc-1")
      if (taken === undefined) {
        throw new Error("the backlog holds no orc-1")
      }
      await run(writeTaken(control, { spec: taken.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-11-18T10:00:00.000Z", log: control + "/logs/orc-1.log" } } }))
      await run(askStartedTask(control, "orc-1", { asked: "2026-11-18T10:01:00.000Z", questions: [{ id: "q9", text: "Which table?", asked: "2026-11-18T10:01:00.000Z" }] }))
      await run(routeTaskItems(control, await run(listTasks(control)), "2026-11-18T10:01:00.000Z"))
      const heardControl: Array<DeciderRequest> = []
      const decided = await run(decideReviewQuestions(control, await run(listTasks(control)), answeringDecider("# Fix the thing", heardControl)))
      expect(heardControl).toHaveLength(1)
      expect(decided.map((entry) => entry.verdict.kind)).toEqual(["answered"])
      expect((await run(listTasks(control))).find((task) => task.spec.id === "orc-1")?.parked?.questions.map((question) => question.answer?.words ?? null)).toEqual(["Table B"])
    } finally {
      await rm(control, { recursive: true, force: true })
    }
    await withDirs(async (root, runs) => {
      const runA = await driveGate(runs, "run-1", { start: parkedTable(["review-1,warning,,,manual,needs a human"]), answers: [] })
      expect(runA.openQuestions).toEqual([{ id: "review-1", text: "needs a human", owner: "user" }])
      await recordGateRun(root, "run-1", "2026-11-18T10:00:00.000Z", runA, runA.result)
      await startOrc1(root, "2026-11-18T10:00:00.000Z")
      const parked = await beatWith(root, doneStatus(root, "2026-11-18T10:00:00.000Z", "2026-11-18T10:01:00.000Z"))
      expect(actionKinds(parked.actions)).toContain("parked:orc-1")
      expect((await run(findTask(root, "orc-1"))).parked?.questions.map((question) => question.owner ?? null)).toEqual(["user"])
      const stored = await run(openItems(root))
      const review = stored.filter((entry) => entry.item.kind === "review-question" && entry.item.task === "orc-1")
      expect(review.map((entry) => entry.item.owner)).toEqual(["user"])
      expect(review.map((entry) => entry.item.state.kind)).toEqual(["open"])
      const heard: Array<DeciderRequest> = []
      const sources = { ...quietSources(), askDecider: answeringDecider("# Fix the thing", heard) }
      for (const [start, end] of [["2026-11-18T10:01:00.000Z", "2026-11-18T10:03:00.000Z"], ["2026-11-18T10:03:00.000Z", "2026-11-18T10:05:00.000Z"]] as const) {
        const waiting = await beatWith(root, doneStatus(root, start, end), sources)
        const kinds = actionKinds(waiting.actions)
        expect(kinds.filter((kind) => kind === "started:orc-1")).toEqual([])
        expect(kinds).toContain("waits:orc-1")
        const waits = waiting.actions.flatMap((action) => action.kind === "waits" && action.task === "orc-1" ? [action.reason] : [])
        expect(waits).toEqual(["parked on orc/orc-1 for the captain's answer to review-1"])
        expect(waiting.actions.filter((action) => action.kind === "attention" && action.task === "orc-1")).toHaveLength(1)
      }
      expect(heard).toEqual([])
      expect((await run(findTask(root, "orc-1"))).parked?.questions.map((question) => question.answer)).toEqual([null])
      expect(await openReviewItems(root)).toHaveLength(1)
    })
  })

  test("a remote parked gate keeps the owner routing instead of dispatching", async () => {
    await withDirs(async (root, runs) => {
      await startOrc1(root, "2026-11-18T10:00:00.000Z")
      const document = {
        schema: "orc.runner.v1",
        result: {
          task: "orc-1", status: "failed", pueueTask: 11,
          started: "2026-11-18T10:00:00.000Z", ended: "2026-11-18T10:01:00.000Z",
          reason: "review-1 needs a human",
          run: { id: "run-9", status: "failed", prLink: null, endReason: "review-1 needs a human", openQuestions: [{ id: "review-1", text: "needs a human", owner: "user" }] }
        }
      }
      await writeFile(join(runs, "remote.json"), JSON.stringify(document))
      await writeFile(join(runs, "remote.sh"), "#!/bin/sh\ncat " + JSON.stringify(join(runs, "remote.json")) + "\n")
      const reach: [string, ...Array<string>] = ["sh", join(runs, "remote.sh")]
      const decoded = await run(readResultThrough(reach, "orc-1"))
      const ending = endingFromResult(decoded, "ship")
      if (ending?.kind !== "park") {
        throw new Error("the remote gate should park")
      }
      await run(parkStartedTask(root, "orc-1", "orc/orc-1", ending.questions, "2026-11-18T10:01:00.000Z", "run-9"))
      expect((await run(findTask(root, "orc-1"))).parked?.questions.map((question) => question.owner ?? null)).toEqual(["user"])
      const stored = await run(openItems(root))
      const review = stored.filter((entry) => entry.item.kind === "review-question" && entry.item.task === "orc-1")
      expect(review.map((entry) => entry.item.owner)).toEqual(["user"])
      const heard: Array<DeciderRequest> = []
      const sources = { ...quietSources(), askDecider: answeringDecider("# Fix the thing", heard) }
      for (const [start, end] of [["2026-11-18T10:01:00.000Z", "2026-11-18T10:03:00.000Z"], ["2026-11-18T10:03:00.000Z", "2026-11-18T10:05:00.000Z"]] as const) {
        const waiting = await beatWith(root, doneStatus(root, start, end), sources)
        const kinds = actionKinds(waiting.actions)
        expect(kinds.filter((kind) => kind === "started:orc-1")).toEqual([])
        expect(kinds).toContain("waits:orc-1")
      }
      expect(heard).toEqual([])
      expect((await run(findTask(root, "orc-1"))).parked?.questions.map((question) => question.answer)).toEqual([null])
      expect(await openReviewItems(root)).toHaveLength(1)
    })
  })

  test("a gate that opens mid-batch is reported once instead of once per timestamp", async () => {
    await withDirs(async (root, runs) => {
      const batch = "2026-11-18T10:00:00.000Z"
      await startOrc1(root, batch)
      await mkdir(join(runs, "run-2"), { recursive: true })
      await writeFile(join(runs, "run-2", "asking.json"), JSON.stringify({ asked: batch, until: batch, questions: [{ id: "ask-7", text: "Worker question?", blocks: false, asked: batch }] }))
      const live: { current: typeof Asking.Type | null } = { current: null }
      const watch = (async () => {
        const end = Date.now() + 8000
        while (Date.now() < end) {
          const text = await readFile(join(runs, "run-2", "asking.json"), "utf8").catch(() => null)
          let asking: typeof Asking.Type | null = null
          if (text !== null) {
            try {
              asking = Schema.decodeUnknownSync(Asking)(JSON.parse(text))
            } catch {
              asking = null
            }
          }
          if (asking !== null && asking.questions.some((question) => question.id === "review-1")) {
            live.current = asking
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      })()
      const runB = await driveGate(runs, "run-2", { start: parkedTable(["review-1,warning,,,manual,needs a human"]), answers: [], waitSeconds: 1 })
      await watch
      const snapshot = live.current
      if (snapshot === null) {
        throw new Error("the live asking never carried the gate")
      }
      const gated = snapshot.questions.find((question) => question.id === "review-1")
      if (gated === undefined) {
        throw new Error("the live asking never carried the gate")
      }
      expect(gated.asked).not.toEqual(batch)
      expect(runB.openQuestions).toEqual([{ id: "review-1", text: "needs a human", asked: gated.asked, asking: batch, owner: "user" }])
      await recordGateRun(root, "run-2", "2026-11-18T10:03:00.000Z", runB, runB.result)
      if (!Arr.isReadonlyArrayNonEmpty(snapshot.questions)) {
        throw new Error("the live asking holds no questions")
      }
      await run(askStartedTask(root, "orc-1", { asked: snapshot.asked, questions: snapshot.questions }))
      const parked = await beatWith(root, doneStatus(root, "2026-11-18T10:02:00.000Z", "2026-11-18T10:05:00.000Z"))
      expect(actionKinds(parked.actions)).toContain("parked:orc-1")
      expect(await openReviewItems(root)).toHaveLength(1)
      const heard: Array<DeciderRequest> = []
      const sources = { ...quietSources(), askDecider: answeringDecider("# Fix the thing", heard) }
      const later = await beatWith(root, doneStatus(root, "2026-11-18T10:02:00.000Z", "2026-11-18T10:05:00.000Z"), sources)
      const kinds = actionKinds(later.actions)
      expect(kinds.filter((kind) => kind === "started:orc-1")).toEqual([])
      expect(kinds).toContain("waits:orc-1")
      expect(heard).toEqual([])
      expect(await openReviewItems(root)).toHaveLength(1)
    })
  })

  test("a repeated asking beside a retained worker question is asked anew instead of reusing its old answer", async () => {
    await withDirs(async (root, runs) => {
      const batch = "2026-11-18T10:00:00.000Z"
      await startOrc1(root, batch)
      await mkdir(join(runs, "run-9"), { recursive: true })
      const first = {
        asked: batch,
        questions: [
          { id: "ask-7", text: "Worker question?", blocks: false, asked: batch },
          { id: "r2", text: "changes product behavior", blocks: true, asked: batch }
        ]
      }
      if (!Arr.isReadonlyArrayNonEmpty(first.questions)) {
        throw new Error("the first asking holds no questions")
      }
      await run(askStartedTask(root, "orc-1", { asked: first.asked, questions: first.questions }))
      await run(answerTask(root, "orc-1", "r2=Table B", "2026-11-18T10:01:00.000Z"))
      await writeFile(join(runs, "run-9", "asking.json"), JSON.stringify({ asked: batch, until: batch, questions: [{ id: "ask-7", text: "Worker question?", blocks: false, asked: batch }] }))
      const live: { current: typeof Asking.Type | null } = { current: null }
      const watch = (async () => {
        const end = Date.now() + 8000
        while (Date.now() < end) {
          const text = await readFile(join(runs, "run-9", "asking.json"), "utf8").catch(() => null)
          let asking: typeof Asking.Type | null = null
          if (text !== null) {
            try {
              asking = Schema.decodeUnknownSync(Asking)(JSON.parse(text))
            } catch {
              asking = null
            }
          }
          if (asking !== null && asking.questions.some((question) => question.id === "r2")) {
            live.current = asking
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      })()
      const record = await driveGate(runs, "run-9", { start: parkedTable(["r2,warning,lint.go,,ask-user,changes product behavior"]), answers: [], waitSeconds: 1 })
      await watch
      const snapshot = live.current
      if (snapshot === null) {
        throw new Error("the live asking never carried the second r2")
      }
      const second = snapshot.questions.find((question) => question.id === "r2")
      if (second?.asked === undefined) {
        throw new Error("the second r2 asking carries no time")
      }
      expect(second.asked).not.toEqual(batch)
      expect(record.openQuestions).toEqual([{ id: "r2", text: "changes product behavior", asked: second.asked, asking: batch }])
      await recordGateRun(root, "run-9", "2026-11-18T10:02:00.000Z", record, record.result)
      const heard: Array<DeciderRequest> = []
      const sources = { ...quietSources(), askDecider: answeringDecider("# Fix the thing", heard) }
      const parked = await beatWith(root, doneStatus(root, "2026-11-18T10:01:00.000Z", "2026-11-18T10:04:00.000Z"), sources)
      const kinds = actionKinds(parked.actions)
      expect(kinds).toContain("parked:orc-1")
      expect(kinds).toContain("started:orc-1")
      const reopened = (await run(findTask(root, "orc-1"))).parked?.questions.find((question) => question.id === "r2")
      expect(reopened?.asked).toEqual(second.asked)
      expect(reopened?.answer?.by ?? null).toEqual("decider")
      expect(heard).toHaveLength(1)
    })
  })
})
