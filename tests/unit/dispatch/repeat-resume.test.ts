import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { addTask, answerWait, claimTask, closeStartedTask, listTasks, renderTaskFile, writeTaken, type ParkedQuestion, type TaskRecord } from "../../../packages/run/src/entities/backlog/index"
import { answerTask, askStartedTask, handAnswersToResume, parkStartedTask, sendBackClosedTask } from "../../../packages/run/src/entities/parked-runs/index"
import { readRequest, type QueueRequest } from "../../../packages/run/src/features/queueing-a-task/runner-request"
import { parseRunArgs } from "../../../packages/run/src/features/running-a-task/run-args"
import { buildResumePlan } from "../../../packages/run/src/features/running-a-task/run-resume"
import { runFull } from "../../../packages/run/src/features/running-a-task/run-loop"
import { recordResumePublish } from "../../../packages/run/src/features/running-a-task/history-write"
import { recordRun } from "../../../packages/run/src/entities/run-history/index"
import { fakeOps } from "../../lib/fake-ops"
import { historyFor, openDb, runLoopCheckpoints, stubGit } from "../../lib/run-loop-helpers"
import { runBeat } from "../../../packages/run/src/widgets/beat/beat"
import { formatBeat } from "../../../packages/run/src/widgets/beat/board"
import { quietSources } from "../../lib/beat-sources"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const spec = { title: "Fix the thing", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0 as const, created: "2026-10-27T10:00:00.000Z", body: "# Fix the thing\n" }

const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-10-27T10:09:00.000Z" }

const asked = "2026-10-27T10:04:00.000Z"
const r2 = { id: "r2", text: "Keep the old flag?" }
const lint = "no-mistakes stopped at the lint gate"

const withResumed = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-repeat-"))
  try {
    const added = await run(addTask(root, spec))
    const answered = { ...r2, asked, blocks: true, answer: { words: "Keep it", at: "2026-10-27T10:05:00.000Z", relayedTo: null } }
    await writeFile(join(root, "new", "orc-1.md"), renderTaskFile({ ...added, parked: { branch: "orc/orc-1", origin: { machine: "mac", run: "run-1" }, questions: [answered] } }))
    await run(claimTask(root, "orc-1"))
    await run(writeTaken(root, { ...handAnswersToResume(await current(root)), state: { kind: "started", claim, started: { at: "2026-10-27T10:10:00.000Z", log: root + "/logs/orc-1.log" } } }))
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

const promptsOfResume = async (root: string, file: string, rereleased: QueueRequest): Promise<Array<string>> => {
  const parsed = parseRunArgs(["task.md", "--branch", "orc/orc-1", ...(rereleased.answers ?? []).flatMap((answer) => ["--answer", answer.question + "=" + answer.answer])])
  if (parsed.kind !== "RunAgent") {
    throw new Error(parsed.detail)
  }
  const db = await openDb(root)
  try {
    const git = await stubGit(root)
    const base = await Effect.runPromise(historyFor("run-5", root, root, "2026-10-27T10:57:00.000Z", git, ""))
    if (parsed.branch === undefined || rereleased.resumeRun === undefined) {
      throw new Error("the released task has no resume branch or run")
    }
    const workerRun = { ...base, branch: parsed.branch, resumeRun: rereleased.resumeRun, answers: parsed.answers }
    await mkdir(workerRun.runDir, { recursive: true })
    await writeFile(workerRun.taskPath, rereleased.body)
    await Effect.runPromise(recordRun(db, { id: rereleased.resumeRun, project: root, branch: parsed.branch, taskFile: file, status: "failed", started: "2026-10-27T10:47:00.000Z" }).pipe(Effect.asVoid))
    const plan = await Effect.runPromise(buildResumePlan(db, workerRun))
    expect(plan.priorDir).toBe(join(root, "runs", "run-4"))
    await Effect.runPromise(recordResumePublish(db, workerRun, plan))
    const prompts: Array<string> = []
    const ops = fakeOps({
      runAgent: async (agentRun) => {
        prompts.push(agentRun.prompt)
        return { commits: [] }
      },
      execCheck: async () => {
        throw new Error("checks ran before the implement finished")
      }
    }, workerRun.hostSessionsDir)
    await Effect.runPromise(runFull(workerRun, ops, plan, runLoopCheckpoints(db, workerRun)))
    return prompts
  } finally {
    db.close()
  }
}

describe("a resumed run that parks again", () => {
  test.each([false, true])("the closing beat reports the current wait instead of answered questions, with new question %s", async (newQuestion) => {
    await withResumed(async (root) => {
      const questions = [{ ...r2, asked }, ...(newQuestion ? [{ id: "r3", text: "Drop the old docs?", asked: "2026-10-27T10:30:00.000Z" }] : [])]
      const resultFile = join(root, "runner-result.json")
      await writeFile(resultFile, JSON.stringify({
        schema: "orc.runner.v1",
        result: {
          task: "orc-1", status: "failed", pueueTask: 1,
          started: "2026-10-27T10:10:00.000Z", ended: "2026-10-27T10:35:00.000Z", reason: lint,
          run: { id: "run-2", status: "failed", prLink: null, endReason: lint, openQuestions: questions }
        }
      }))
      const quotaReply = JSON.stringify({ schema: "orc.quota.v1", accounts: [{ name: "main", remainingPercent: 80 }] })
      await writeFile(join(root, "dispatch.json"), JSON.stringify({
        machines: [{ name: "mac", slots: 1, start: ["orc", "runner", "start", "--", "sh", "-c", 'cat "$1"', "runner-result", resultFile] }],
        quota: { provider: "keyed", command: ["sh", "-c", "printf '%s' '" + quotaReply + "'"], accounts: [{ name: "main", kind: "none" }], floorPercent: 15 }
      }))
      await writeFile(join(root, "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { mac: root } }] }))
      const report = await run(runBeat(root, root, quietSources()))
      const lines = formatBeat(report).split("\n")
      expect(lines).not.toContain("parked orc-1 on orc/orc-1 for the captain's answer to r2")
      if (newQuestion) {
        expect(report.actions).toContainEqual({ kind: "parked", task: "orc-1", machine: "mac", branch: "orc/orc-1", questions: ["r3"], decider: [] })
        expect(lines).toContain("parked orc-1 on orc/orc-1 for the captain's answer to r3")
      } else {
        const reason = (await current(root)).hold?.reason ?? ""
        expect(reason).toContain("run-2")
        expect(report.actions).toContainEqual({ kind: "held", task: "orc-1", machine: "mac", reason })
        expect(lines).toContain("held orc-1 on mac: " + reason)
        expect(await run(answerTask(root, "orc-1", "fix the lint finding first", "2026-10-27T10:40:00.000Z"))).toMatchObject({ kind: "hold" })
      }
    })
  })

  test("parking on only the answers handed to it holds the task with the run's end reason instead of resuming it on the next beat", async () => {
    await withResumed(async (root) => {
      const parked = await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ ...r2, asked }], "2026-10-27T10:35:00.000Z", "run-2", lint))
      expect(parked.hold?.reason).toContain("run-2")
      expect(parked.hold?.reason).toContain(lint)
      expect(answerWait(parked, () => false)).toStartWith("held for the captain: ")
    })
  })
  test("an answer given during the run resumes it instead of holding it", async () => {
    await withResumed(async (root) => {
      const again = "2026-10-27T10:15:00.000Z"
      await run(askStartedTask(root, "orc-1", { asked: again, questions: [r2] }))
      await run(answerTask(root, "orc-1", "r2=Drop it", "2026-10-27T10:20:00.000Z"))
      const parked = await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ ...r2, asked: again }], "2026-10-27T10:35:00.000Z", "run-2", lint))
      expect(parked.hold).toBeNull()
      expect(answerWait(parked, () => false)).toBeNull()
    })
  })
  test("a new question parks it for the captain instead of holding it", async () => {
    await withResumed(async (root) => {
      const parked = await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ id: "r3", text: "Drop the old docs?", asked: "2026-10-27T10:30:00.000Z" }], "2026-10-27T10:35:00.000Z", "run-2", lint))
      expect(parked.hold).toBeNull()
      expect(answerWait(parked, () => false)).toBe("parked on orc/orc-1 for the captain's answer to r3")
    })
  })
  test("the captain's answer releases the hold instead of refusing a parked task with no open question", async () => {
    await withResumed(async (root) => {
      await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ ...r2, asked }], "2026-10-27T10:35:00.000Z", "run-2", lint))
      expect(await run(answerTask(root, "orc-1", "fix the lint finding first", "2026-10-27T10:40:00.000Z"))).toMatchObject({ kind: "hold" })
      expect(answerWait(await current(root), () => false)).toBeNull()
    })
  })
  test("an unanswered non-blocking question holds the task instead of retrying the same resume endlessly", async () => {
    await withResumed(async (root) => {
      const question = { id: "ask-1", text: "Pick a color?", asked: "2026-10-27T10:30:00.000Z", blocks: false }
      const parked = await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ ...r2, asked }, question], "2026-10-27T10:35:00.000Z", "run-2", lint))
      expect(parked.hold?.reason).toBe("the resumed run run-2 ended with no new blocking question and no answer given during it (" + lint + "), so the beat stops resuming it with the same answers")
      expect(answerWait(parked, () => false)).toStartWith("held for the captain: ")
      expect(await run(answerTask(root, "orc-1", "try the blue one", "2026-10-27T10:40:00.000Z"))).toMatchObject({ kind: "hold" })
      expect(answerWait(await current(root), () => false)).toBeNull()
    })
  })
  test("a correction to the decider's answer reaches the parked question instead of releasing the hold", async () => {
    const root = await mkdtemp(join(tmpdir(), "orc-repeat-"))
    try {
      const added = await run(addTask(root, spec))
      const deciderAnswered = { ...r2, asked, blocks: true, answer: { words: "Keep it", at: "2026-10-27T10:05:00.000Z", relayedTo: null, by: "decider" as const } }
      await writeFile(join(root, "new", "orc-1.md"), renderTaskFile({ ...added, parked: { branch: "orc/orc-1", origin: { machine: "mac", run: "run-1" }, questions: [deciderAnswered] } }))
      await run(claimTask(root, "orc-1"))
      await run(writeTaken(root, { ...handAnswersToResume(await current(root)), state: { kind: "started", claim, started: { at: "2026-10-27T10:10:00.000Z", log: root + "/logs/orc-1.log" } } }))
      await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ ...r2, asked }], "2026-10-27T10:35:00.000Z", "run-2", lint))
      expect(await run(answerTask(root, "orc-1", "r2=Drop it", "2026-10-27T10:40:00.000Z", { kind: "parked" }))).toMatchObject({ kind: "question", question: "r2" })
      const corrected = await current(root)
      expect(corrected.hold?.answer).toBeNull()
      expect(corrected.parked?.questions.find((question) => question.id === "r2")?.answer).toMatchObject({ words: "Drop it", overturned: { words: "Keep it" } })
      expect(await run(answerTask(root, "orc-1", "fix the lint finding first", "2026-10-27T10:45:00.000Z"))).toMatchObject({ kind: "hold" })
      expect(answerWait(await current(root), () => false)).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test("releasing the hold leaves the queued task body unchanged and hands the release to the resume as an answer", async () => {
    await withResumed(async (root) => {
      await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ ...r2, asked }], "2026-10-27T10:35:00.000Z", "run-2", lint))
      const file = join(root, "new", "orc-1.md")
      const queued = () => run(readRequest({ ORC_TASK_ID: "orc-1", ORC_TASK_FILE: file, ORC_TASK_CHECKOUT: join(root, "checkout"), ORC_TASK_PROVIDER: "test-provider" }, Effect.succeed("")))
      const before = await queued()
      expect(await run(answerTask(root, "orc-1", "fix the lint finding first", "2026-10-27T10:40:00.000Z"))).toMatchObject({ kind: "hold" })
      const after = await queued()
      expect(after.body).toBe(before.body)
      expect(after.body).not.toContain("Held for the captain")
      expect(after.answers).toEqual([{ question: "r2", answer: "Keep it" }, { question: "hold-release", answer: "Current guidance: fix the lint finding first" }])
    })
  })
  test("a resume after the fixer's question marks the release as carried instead of handing it as new again", async () => {
    await withResumed(async (root) => {
      await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ ...r2, asked }], "2026-10-27T10:35:00.000Z", "run-2", lint))
      await run(answerTask(root, "orc-1", "fix the lint finding first", "2026-10-27T10:40:00.000Z"))
      const file = join(root, "new", "orc-1.md")
      const queued = () => run(readRequest({ ORC_TASK_ID: "orc-1", ORC_TASK_FILE: file, ORC_TASK_CHECKOUT: join(root, "checkout"), ORC_TASK_PROVIDER: "test-provider" }, Effect.succeed("")))
      expect((await queued()).answers).toContainEqual({ question: "hold-release", answer: "Current guidance: fix the lint finding first" })
      await run(claimTask(root, "orc-1"))
      await run(writeTaken(root, { ...handAnswersToResume(await current(root)), state: { kind: "started", claim, started: { at: "2026-10-27T10:45:00.000Z", log: root + "/logs/orc-1.log" } } }))
      const fixerAsks = { id: "ask-1", text: "Pin the linter version?", asked: "2026-10-27T10:50:00.000Z", blocks: true }
      const parked = await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ ...r2, asked }, fixerAsks], "2026-10-27T10:55:00.000Z", "run-3", lint))
      expect(answerWait(parked, () => false)).not.toStartWith("held for the captain: ")
      await run(answerTask(root, "orc-1", "ask-1=Pin it", "2026-10-27T11:00:00.000Z"))
      expect((await queued()).answers).toEqual([
        { question: "r2", answer: "Keep it" },
        { question: "ask-1", answer: "Pin it" },
        { question: "hold-release-carried", answer: "Current guidance: fix the lint finding first" }
      ])
    })
  })
  test("a send-back hands its resume only the review instead of an old release as current guidance", async () => {
    await withResumed(async (root) => {
      await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ ...r2, asked }], "2026-10-27T10:35:00.000Z", "run-2", lint))
      await run(answerTask(root, "orc-1", "fix the lint finding first", "2026-10-27T10:40:00.000Z"))
      await run(claimTask(root, "orc-1"))
      await run(writeTaken(root, { ...handAnswersToResume(await current(root)), state: { kind: "started", claim, started: { at: "2026-10-27T10:45:00.000Z", log: root + "/logs/orc-1.log" } } }))
      await run(closeStartedTask(root, "orc-1", "done", "", { pr: "https://github.com/acme/orc/pull/8", report: null }, "2026-10-27T11:00:00.000Z"))
      await run(sendBackClosedTask(root, "orc-1", "rename the flag", "2026-10-27T12:00:00.000Z", { machine: "mac", run: "run-3" }))
      const file = join(root, "new", "orc-1.md")
      const queued = await run(readRequest({ ORC_TASK_ID: "orc-1", ORC_TASK_FILE: file, ORC_TASK_CHECKOUT: join(root, "checkout"), ORC_TASK_PROVIDER: "test-provider" }, Effect.succeed("")))
      expect(queued.answers).toEqual([{ question: "send-back", answer: "rename the flag" }])
    })
  })
  test("a fixer that loops again after a release keeps the release instead of dropping it with the replaced loop question", async () => {
    await withResumed(async (root) => {
      await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ ...r2, asked }], "2026-10-27T10:35:00.000Z", "run-2", lint))
      await run(answerTask(root, "orc-1", "fix the lint finding first", "2026-10-27T10:40:00.000Z"))
      await run(claimTask(root, "orc-1"))
      await run(writeTaken(root, { ...handAnswersToResume(await current(root)), state: { kind: "started", claim, started: { at: "2026-10-27T10:45:00.000Z", log: root + "/logs/orc-1.log" } } }))
      const loopsAgain = { id: "looping", text: "One command failed 6 times in a row. Continue?", asked: "2026-10-27T10:50:00.000Z", blocks: true }
      await run(parkStartedTask(root, "orc-1", "orc/orc-1", [loopsAgain], "2026-10-27T10:55:00.000Z", "run-3", lint))
      expect((await current(root)).parked?.questions.map((question) => question.id)).toEqual(["looping"])
      await run(answerTask(root, "orc-1", "looping=continue", "2026-10-27T11:00:00.000Z"))
      const file = join(root, "new", "orc-1.md")
      const queued = await run(readRequest({ ORC_TASK_ID: "orc-1", ORC_TASK_FILE: file, ORC_TASK_CHECKOUT: join(root, "checkout"), ORC_TASK_PROVIDER: "test-provider" }, Effect.succeed("")))
      expect(queued.answers).toEqual([
        { question: "looping", answer: "continue" },
        { question: "hold-release-carried", answer: "Current guidance: fix the lint finding first" }
      ])
    })
  })
  test("an answer to a non-blocking question given during the run resumes it instead of holding it", async () => {
    const root = await mkdtemp(join(tmpdir(), "orc-repeat-"))
    try {
      const added = await run(addTask(root, spec))
      const handed: [ParkedQuestion, ...ParkedQuestion[]] = [
        { ...r2, asked, blocks: true, answer: { words: "Keep it", at: "2026-10-27T10:05:00.000Z", relayedTo: null } },
        { id: "ask-1", text: "Pick a color?", asked, blocks: false, answer: null }
      ]
      await writeFile(join(root, "new", "orc-1.md"), renderTaskFile({ ...added, parked: { branch: "orc/orc-1", origin: { machine: "mac", run: "run-1" }, questions: handed } }))
      await run(claimTask(root, "orc-1"))
      await run(writeTaken(root, { ...handAnswersToResume(await current(root)), state: { kind: "started", claim, started: { at: "2026-10-27T10:10:00.000Z", log: root + "/logs/orc-1.log" } } }))
      await run(answerTask(root, "orc-1", "ask-1=Blue", "2026-10-27T10:20:00.000Z"))
      const parked = await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ ...r2, asked }, { id: "ask-1", text: "Pick a color?", asked, blocks: false }], "2026-10-27T10:35:00.000Z", "run-2", lint))
      expect(parked.hold).toBeNull()
      expect(answerWait(parked, () => false)).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test("the next resume keeps both releases in order instead of dropping earlier guidance", async () => {
    const root = await mkdtemp(join(tmpdir(), "orc-repeat-"))
    try {
      const added = await run(addTask(root, spec))
      await writeFile(join(root, "new", "orc-1.md"), renderTaskFile({ ...added, hold: { reason: "Wait for the merge", until: null, questions: [{ id: "question-1", text: "Which format?", answer: null }], answer: null, at: "2026-10-27T09:55:00.000Z" } }))
      await run(answerTask(root, "orc-1", "question-1=JSON", "2026-10-27T09:58:00.000Z"))
      const file = join(root, "new", "orc-1.md")
      const queued = () => run(readRequest({ ORC_TASK_ID: "orc-1", ORC_TASK_FILE: file, ORC_TASK_CHECKOUT: join(root, "checkout"), ORC_TASK_PROVIDER: "test-provider" }, Effect.succeed("")))
      const first = await queued()
      expect(first.body).toContain("The captain answered: Which format?: JSON")
      await run(claimTask(root, "orc-1"))
      await run(writeTaken(root, { ...handAnswersToResume(await current(root)), state: { kind: "started", claim, started: { at: "2026-10-27T10:10:00.000Z", log: root + "/logs/orc-1.log" } } }))
      await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ ...r2, asked, blocks: true }], "2026-10-27T10:35:00.000Z", "run-2", lint))
      await run(answerTask(root, "orc-1", "r2=Keep it", "2026-10-27T10:36:00.000Z"))
      expect((await queued()).body).toBe(first.body)
      await run(claimTask(root, "orc-1"))
      await run(writeTaken(root, { ...handAnswersToResume(await current(root)), state: { kind: "started", claim, started: { at: "2026-10-27T10:37:00.000Z", log: root + "/logs/orc-1.log" } } }))
      await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ ...r2, asked, blocks: true }], "2026-10-27T10:45:00.000Z", "run-3", lint))
      expect((await current(root)).hold?.reason).toContain("run-3")
      await run(answerTask(root, "orc-1", "fix the lint finding first", "2026-10-27T10:46:00.000Z"))
      const released = await queued()
      expect(released.body).toBe(first.body)
      expect(released.answers).toContainEqual({ question: "hold-release", answer: "Current guidance: fix the lint finding first" })
      await run(claimTask(root, "orc-1"))
      await run(writeTaken(root, { ...handAnswersToResume(await current(root)), state: { kind: "started", claim, started: { at: "2026-10-27T10:47:00.000Z", log: root + "/logs/orc-1.log" } } }))
      await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ ...r2, asked, blocks: true }], "2026-10-27T10:55:00.000Z", "run-4", lint))
      await run(answerTask(root, "orc-1", "try the other flag instead", "2026-10-27T10:56:00.000Z"))
      const rereleased = await queued()
      expect(rereleased.body).toBe(first.body)
      const guidance = "Earlier repeat hold release: fix the lint finding first\nCurrent guidance: try the other flag instead"
      expect(rereleased.answers).toEqual([{ question: "r2", answer: "Keep it" }, { question: "hold-release", answer: guidance }])
      const prompts = await promptsOfResume(root, file, rereleased)
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain(guidance)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
