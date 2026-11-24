import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { TaskRecord } from "../../../packages/run/src/entities/backlog/index"
import type { PrState } from "../../../packages/run/src/entities/events/index"
import { ciWaitingQuestionId } from "../../../packages/run/src/features/running-a-task/run-ops"
import { backlogJson, type BacklogView } from "../../../packages/run/src/widgets/beat/board"
import type { TaskWait } from "../../../packages/run/src/widgets/beat/beat-place"
import { type Actor, boardNext, type TaskNext } from "../../../trials/bb/plugin/board-next"

const orcActors = {
  "no-priority": "owner",
  decision: "owner",
  held: "owner",
  parked: "owner",
  depends: "orc",
  room: "orc",
  taken: "orc",
  started: "orc",
  "open-pr": "owner",
  failed: "owner",
  decider: "orc",
  "start-failed": "owner",
  "ci-waiting": "ci"
} as const satisfies Record<TaskWait["kind"] | "room" | "taken" | "started" | "open-pr" | "failed" | "start-failed" | "decider" | "ci-waiting", Actor>

const pr = "https://github.com/avi2d/orc/pull/7"
const spec = { title: "Fix the thing", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0 as const, created: "2026-10-27T10:00:00.000Z", body: "# Fix the thing\n" }
const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-10-27T10:01:00.000Z" }
const started = { at: "2026-10-27T10:02:00.000Z", log: "/logs/run.log" }

const asNew = (id: string, change: Partial<TaskRecord> = {}, specChange: Partial<TaskRecord["spec"]> = {}): TaskRecord =>
  ({ spec: { ...spec, id, ...specChange }, hold: null, parked: null, state: { kind: "new" }, ...change })

const closed = (id: string, outcome: "done" | "failed" | "stopped", link: string | null): TaskRecord => ({
  ...asNew(id),
  state: { kind: "closed", claim, closing: { outcome, started, reason: "the run ended", pr: link, report: null }, closedAt: "2026-10-27T11:00:00.000Z", postedAt: null }
})

const question = (id: string, text: string, answered = false) =>
  ({ id, text, asked: "2026-10-27T10:03:00.000Z", blocks: true, answer: answered ? { words: "go on", at: "2026-10-27T10:04:00.000Z", relayedTo: null } : null })

const parkedOn = (questions: NonNullable<TaskRecord["parked"]>["questions"], origin: { readonly machine: string; readonly run: string; readonly pr?: string } = { machine: "mac", run: "run-1" }): Partial<TaskRecord> =>
  ({ parked: { origin, branch: "orc/orc-1", questions } })

const boardOf = (tasks: ReadonlyArray<TaskRecord>, prStates: ReadonlyMap<string, PrState | null> = new Map(), deciderOwns: BacklogView["deciderOwns"] = () => false) => {
  const view: BacklogView = { tasks, events: [], projects: { kind: "read", projects: [] }, room: { kind: "read", room: [] }, merged: new Set(), prStates, beatWaits: null, deciderOwns }
  return backlogJson(view)
}

const parsed = (board: unknown): unknown => JSON.parse(JSON.stringify(board))

const nextOf = (tasks: ReadonlyArray<TaskRecord>, prStates?: ReadonlyMap<string, PrState | null>, deciderOwns?: BacklogView["deciderOwns"]): ReadonlyArray<TaskNext> =>
  Effect.runSync(boardNext(parsed(boardOf(tasks, prStates, deciderOwns))))

const refusal = (board: unknown): string => Effect.runSync(Effect.flip(boardNext(board))).message

describe("what a new task waits for", () => {
  test("a task with no priority is not left to orc, since orc never starts it until the owner gives one", () => {
    const [next] = nextOf([asNew("orc-1", {}, { priority: null })])
    expect(next.next).toEqual({ waits: "priority", actor: orcActors["no-priority"] })
  })
  test("a decision is not left to orc to run, since only the owner's answer closes it", () => {
    const [next] = nextOf([asNew("orc-1", {}, { kind: "decision" })])
    expect(next.next).toEqual({ waits: "decision", actor: orcActors.decision })
  })
  test("a held task is not attributed to orc while orc says it is held for the captain", () => {
    const [next] = nextOf([asNew("orc-1", { hold: { reason: "which API shape", until: null, questions: [], answer: null, at: null } })])
    expect(next.next).toEqual({ waits: "hold", actor: orcActors.held })
  })
  test("a parked question for the captain is not attributed to orc or CI", () => {
    const [next] = nextOf([asNew("orc-1", parkedOn([question("q1", "Which table?")]))])
    expect(next.next).toEqual({ waits: "answer", actor: orcActors.parked, questions: ["q1"] })
  })
  test("a decider-owned blocking question is not attributed to the owner", () => {
    const [next] = nextOf([asNew("orc-1", parkedOn([question("q1", "Which table?")]))], undefined, () => true)
    expect(next.next).toEqual({ waits: "answer", actor: orcActors.decider, questions: ["q1"] })
  })
  test("a blocking owner question is not hidden by a decider-owned question in either order", () => {
    const owner = question("owner", "Which table?")
    const decider = question("decider", "Which column?")
    const tasks = [
      asNew("orc-1", parkedOn([owner, decider])),
      asNew("orc-2", parkedOn([decider, owner]))
    ]
    const nexts = nextOf(tasks, undefined, (_task, asked) => asked.id === "decider")
    expect(nexts.map((next) => next.next)).toEqual([
      { waits: "answer", actor: orcActors.parked, questions: ["owner", "decider"] },
      { waits: "answer", actor: orcActors.parked, questions: ["decider", "owner"] }
    ])
  })
  test("answered and non-blocking owner questions do not take a blocking wait from the decider", () => {
    const [next] = nextOf([asNew("orc-1", parkedOn([
      question("decider", "Which column?"),
      { ...question("owner", "Which table?"), blocks: false },
      question("answered", "Which API?", true)
    ]))], undefined, (_task, asked) => asked.id === "decider")
    expect(next.next).toEqual({ waits: "answer", actor: orcActors.decider, questions: ["decider"] })
  })
  test("a missing parked origin is not left to orc after all blocking answers arrive", () => {
    const task = asNew("orc-1", { parked: { branch: "orc/orc-1", questions: [question("q1", "Which table?", true)] } })
    const [next] = nextOf([task], undefined, () => true)
    expect(next.next).toEqual({ waits: "answer", actor: orcActors.parked, questions: [] })
  })
  test("a run waiting on pending CI is not attributed to the owner, and its PR is not lost", () => {
    const text = "GitHub CI has not finished on abc123 for " + pr + ": 2 check runs are unfinished. The PR stays open while the run waits on CI."
    const [next] = nextOf([asNew("orc-1", parkedOn([question(ciWaitingQuestionId, text)]))])
    expect(next.next).toEqual({ waits: "ci", actor: orcActors["ci-waiting"] })
    expect(next.pr).toBe(pr)
  })
  test("non-blocking and answered questions do not turn a CI wait into an owner wait", () => {
    const [next] = nextOf([asNew("orc-1", parkedOn([
      question(ciWaitingQuestionId, "CI pending for " + pr),
      { ...question("q1", "Which table?"), blocks: false },
      question("q2", "Which column?", true)
    ]))])
    expect(next.next).toEqual({ waits: "ci", actor: orcActors["ci-waiting"] })
    expect(next.pr).toBe(pr)
  })
  test("a blocking decider question beside CI is not attributed to the owner or CI", () => {
    const [next] = nextOf([asNew("orc-1", parkedOn([
      question(ciWaitingQuestionId, "CI pending for " + pr),
      question("q1", "Which table?")
    ]))], undefined, (_task, asked) => asked.id === "q1")
    expect(next.next).toEqual({ waits: "answer", actor: orcActors.decider, questions: [ciWaitingQuestionId, "q1"] })
  })
  test("a CI wait beside an open captain question is not attributed to CI, since the owner's answer is still needed", () => {
    const [next] = nextOf([asNew("orc-1", parkedOn([question(ciWaitingQuestionId, "GitHub CI has not finished"), question("q1", "Which table?")]))])
    expect(next.next).toMatchObject({ actor: orcActors.parked })
  })
  test("a task behind an open dependency is not attributed to the owner", () => {
    const [next] = nextOf([asNew("orc-1", {}, { dependsOn: ["orc-2"] }), asNew("orc-2")])
    expect(next.next).toEqual({ waits: "dependency", actor: orcActors.depends })
  })
  test("a ready task waiting for a free slot is not attributed to the owner", () => {
    const [next] = nextOf([asNew("orc-1")])
    expect(next).toEqual({ id: "orc-1", title: "Fix the thing", next: { waits: "room", actor: orcActors.room }, pr: null })
  })
  test("a sent-back task whose answer is in keeps the PR it was sent back on rather than showing none", () => {
    const [next] = nextOf([asNew("orc-1", parkedOn([question("send-back", "rename the flag", true)], { machine: "mac", run: "run-1", pr }))])
    expect(next.next).toEqual({ waits: "room", actor: orcActors.room })
    expect(next.pr).toBe(pr)
  })
})

describe("PR URLs", () => {
  test.each(["#7", "http://github.com/avi2d/orc/pull/7", "prefix " + pr, pr + "?tab=checks", pr + "/files", pr + " "])("a sent-back PR reference %s is not returned as a full PR URL", (link) => {
    const [next] = nextOf([asNew("orc-1", parkedOn([question("send-back", "Rename the flag", true)], { machine: "mac", run: "run-1", pr: link }))])
    expect(next.pr).toBeNull()
  })
  test("a full sent-back PR URL is not lost while a task is taken or started", () => {
    const parked = parkedOn([question("send-back", "Rename the flag", true)], { machine: "mac", run: "run-1", pr })
    const taken: TaskRecord = { ...asNew("orc-1", parked), state: { kind: "taken", claim } }
    const running: TaskRecord = { ...asNew("orc-2", parked), state: { kind: "started", claim, started } }
    expect(nextOf([taken, running]).map((next) => next.pr)).toEqual([pr, pr])
  })
})

describe("what a taken or closed task waits for", () => {
  test("a taken or started task is not attributed to the owner", () => {
    const taken: TaskRecord = { ...asNew("orc-1"), state: { kind: "taken", claim } }
    const running: TaskRecord = { ...asNew("orc-2"), state: { kind: "started", claim, started } }
    expect(nextOf([taken, running]).map((next) => next.next)).toEqual([{ waits: "run", actor: orcActors.taken }, { waits: "run", actor: orcActors.started }])
  })
  test("a closed task with an open PR is not shown as done with nobody to act", () => {
    const [next] = nextOf([closed("orc-1", "done", pr)], new Map([["orc-1", "open"]]))
    expect(next.next).toEqual({ waits: "pull-request", actor: orcActors["open-pr"] })
    expect(next.pr).toBe(pr)
  })
  test("a run that failed is not shown as done with nobody to act", () => {
    const [next] = nextOf([closed("orc-1", "failed", null)])
    expect(next.next).toEqual({ waits: "failed-run", actor: orcActors.failed })
  })
  test("a run whose start failed is not shown as done with nobody to act", () => {
    const task: TaskRecord = {
      ...asNew("orc-1"),
      state: { kind: "closed", claim, closing: { outcome: "start-failed", reason: "cannot start" }, closedAt: "2026-10-27T11:00:00.000Z", postedAt: null }
    }
    const [next] = nextOf([task])
    expect(next.next).toEqual({ waits: "failed-run", actor: orcActors["start-failed"] })
    expect(next.pr).toBeNull()
  })
  test("a dropped task is not shown as a failed run needing the owner", () => {
    const task: TaskRecord = {
      ...asNew("orc-1"),
      state: { kind: "closed", claim: null, closing: { outcome: "dropped", reason: "not needed" }, closedAt: "2026-10-27T11:00:00.000Z", postedAt: null }
    }
    const [next] = nextOf([task])
    expect(next.next).toEqual({ waits: "nothing" })
    expect(next.pr).toBeNull()
  })
  test("a merged or stopped task names no one to act rather than the owner", () => {
    const nexts = nextOf([closed("orc-1", "done", pr), closed("orc-2", "stopped", null)], new Map([["orc-1", "merged"]]))
    expect(nexts.map((next) => next.next)).toEqual([{ waits: "nothing" }, { waits: "nothing" }])
    expect(nexts.map((next) => next.pr)).toEqual([pr, null])
  })
})

describe("reading the Board JSON", () => {
  test("a document that is not orc.backlog.v1 is refused rather than read as an empty board", () => {
    expect(refusal({ schema: "orc.runs.v1", tasks: [] })).toContain(`["schema"]`)
  })
  test.each(["blocks", "deciderOwns"] as const)("invalid %s question metadata is refused rather than guessing its actor", (field) => {
    const board = boardOf([asNew("orc-1", parkedOn([question("q1", "Which table?")]))])
    const invalid = {
      ...board,
      tasks: board.tasks.map((task) => ({
        ...task,
        parked: { ...task.parked, questions: task.parked?.questions.map((asked) => ({ ...asked, [field]: "true" })) }
      }))
    }
    expect(refusal(parsed(invalid))).toContain(`["tasks"][0]["parked"]["questions"][0]["${field}"]`)
  })
  test("a waiting kind orc does not define is refused rather than guessed", () => {
    const board = boardOf([asNew("orc-1")])
    const unknownWait = { ...board, tasks: board.tasks.map((task) => ({ ...task, waiting: { kind: "later", detail: null } })) }
    expect(refusal(parsed(unknownWait))).toContain(`["tasks"][0]["waiting"]["kind"]`)
  })
})
