import { describe, expect, test } from "bun:test"
import type { TaskRecord } from "../../../packages/run/src/entities/backlog/index"
import type { PrState } from "../../../packages/run/src/entities/events/index"
import { ciWaitingQuestionId } from "../../../packages/run/src/features/running-a-task/run-ops"
import { backlogJson, type BacklogView } from "../../../packages/run/src/widgets/beat/board"
import type { TaskWait } from "../../../packages/run/src/widgets/beat/beat-place"
import { type Actor, boardNext, type TaskNext } from "../../../trials/bb/board-next"

// These actors copy docs/concepts/backlog.md, docs/concepts/attention.md and docs/run/delivery-modes.md, so the module under test never sets what the tests expect.
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
  "ci-waiting": "ci"
} as const satisfies Record<TaskWait["kind"] | "room" | "taken" | "started" | "open-pr" | "failed" | "ci-waiting", Actor>

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

const boardOf = (tasks: ReadonlyArray<TaskRecord>, prStates: ReadonlyMap<string, PrState | null> = new Map()) => {
  const view: BacklogView = { tasks, events: [], projects: { kind: "read", projects: [] }, room: { kind: "read", room: [] }, merged: new Set(), prStates, beatWaits: null, deciderOwns: () => false }
  return backlogJson(view)
}

const parsed = (board: unknown): unknown => JSON.parse(JSON.stringify(board))

const nextOf = (tasks: ReadonlyArray<TaskRecord>, prStates?: ReadonlyMap<string, PrState | null>): ReadonlyArray<TaskNext> => {
  const read = boardNext(parsed(boardOf(tasks, prStates)), "")
  if (read.kind === "refused") throw new Error(read.reason)
  return read.value
}

describe("what a new task waits for", () => {
  test("a task with no priority is not left to orc, since orc never starts it until the owner gives one", () => {
    const [next] = nextOf([asNew("orc-1", {}, { priority: null })])
    expect(next.next).toEqual({ waits: "priority", actor: orcActors["no-priority"] })
  })
  test("a decision is not left to orc to run, since only the owner's answer closes it", () => {
    const [next] = nextOf([asNew("orc-1", {}, { kind: "decision" })])
    expect(next.next).toEqual({ waits: "decision", actor: orcActors.decision })
    expect(next.detail).toContain("captain")
  })
  test("a held task is not attributed to orc while orc says it is held for the captain", () => {
    const [next] = nextOf([asNew("orc-1", { hold: { reason: "which API shape", until: null, questions: [], answer: null, at: null } })])
    expect(next.next).toEqual({ waits: "hold", actor: orcActors.held })
    expect(next.detail).toBe("held for the captain: which API shape")
  })
  test("a parked question for the captain is not attributed to orc or CI", () => {
    const [next] = nextOf([asNew("orc-1", parkedOn([question("q1", "Which table?")]))])
    expect(next.next).toEqual({ waits: "answer", actor: orcActors.parked, questions: ["q1"] })
  })
  test("a run waiting on pending CI is not attributed to the owner, and its PR is not lost", () => {
    const text = "GitHub CI has not finished on abc123 for " + pr + ": 2 check runs are unfinished. The PR stays open while the run waits on CI."
    const [next] = nextOf([asNew("orc-1", parkedOn([question(ciWaitingQuestionId, text)]))])
    expect(next.next).toEqual({ waits: "ci", actor: orcActors["ci-waiting"] })
    expect(next.pr).toBe(pr)
  })
  test("a CI wait beside an open captain question is not attributed to CI, since the owner's answer is still needed", () => {
    const [next] = nextOf([asNew("orc-1", parkedOn([question(ciWaitingQuestionId, "GitHub CI has not finished"), question("q1", "Which table?")]))])
    expect(next.next).toMatchObject({ actor: orcActors.parked })
  })
  test("a task behind an open dependency is not attributed to the owner", () => {
    const [next] = nextOf([asNew("orc-1", {}, { dependsOn: ["orc-2"] }), asNew("orc-2")])
    expect(next.next).toEqual({ waits: "dependency", actor: orcActors.depends })
    expect(next.detail).toBe("waits on orc-2")
  })
  test("a ready task waiting for a free slot is not attributed to the owner", () => {
    const [next] = nextOf([asNew("orc-1")])
    expect(next.next).toEqual({ waits: "room", actor: orcActors.room })
  })
  test("a sent-back task whose answer is in keeps the PR it was sent back on rather than showing none", () => {
    const [next] = nextOf([asNew("orc-1", parkedOn([question("send-back", "rename the flag", true)], { machine: "mac", run: "run-1", pr }))])
    expect(next.next).toEqual({ waits: "room", actor: orcActors.room })
    expect(next.pr).toBe(pr)
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
  test("a merged or stopped task names no one to act rather than the owner", () => {
    const nexts = nextOf([closed("orc-1", "done", pr), closed("orc-2", "stopped", null)], new Map([["orc-1", "merged"]]))
    expect(nexts.map((next) => next.next)).toEqual([{ waits: "nothing" }, { waits: "nothing" }])
    expect(nexts.map((next) => next.pr)).toEqual([pr, null])
  })
})

describe("reading the Board JSON", () => {
  test("a document that is not orc.backlog.v1 is refused rather than read as an empty board", () => {
    expect(boardNext({ schema: "orc.runs.v1", tasks: [] }, "")).toMatchObject({ kind: "refused" })
  })
  test("a waiting kind orc does not define is refused rather than guessed", () => {
    const board = boardOf([asNew("orc-1")])
    const unknownWait = { ...board, tasks: board.tasks.map((task) => ({ ...task, waiting: { kind: "later", detail: null } })) }
    expect(boardNext(parsed(unknownWait), "")).toMatchObject({ kind: "refused", reason: expect.stringContaining("tasks[0].waiting.kind") })
  })
})
