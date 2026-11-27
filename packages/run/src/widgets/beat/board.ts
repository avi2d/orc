import { type BeatAction, type BeatReport, type MachineRoom } from "./beat"
import type { BeatWaits } from "./beat-waits"
import { type TaskWait, taskWaiting } from "./beat-place"
import { type ChildCount, childCount, decisionAnswer, dependencyWaits, fullPrUrl, type TaskKind, type TaskPriority, answersAwaited, type Claim, type DeciderOwns, type Hold, isDeciderAnswer, isHeld, openQuestions, type Parked, ranClosing, taskLandedIn, type SplitMark, type Started, type TaskRecord } from "../../entities/backlog/index"
import type { Project } from "../../shared/config/index"
import { describeQuota } from "./quota"
import type { ChatEvent, PrState } from "../../entities/events/index"
import { type DecisionAnswer, deciderHeadings, notRecordedBasis } from "../../shared/lib/index"
import { updateLine } from "../../entities/attention/index"

const BACKLOG_JSON_SCHEMA = "orc.backlog.v1" as const
const BEAT_JSON_SCHEMA = "orc.beat.v1" as const

export type ProjectList = { readonly kind: "read"; readonly projects: ReadonlyArray<Project> } | { readonly kind: "unread"; readonly reason: string }
export type RoomList = { readonly kind: "read"; readonly room: ReadonlyArray<MachineRoom> } | { readonly kind: "unread"; readonly reason: string }

export interface BacklogView {
  readonly tasks: ReadonlyArray<TaskRecord>
  readonly events: ReadonlyArray<ChatEvent>
  readonly projects: ProjectList
  readonly room: RoomList
  readonly merged: ReadonlySet<string>
  readonly prStates: ReadonlyMap<string, PrState | null>
  readonly beatWaits: BeatWaits | null
  readonly deciderOwns: DeciderOwns
}

type WaitingJson = TaskWait | { readonly kind: "room"; readonly detail: string | null; readonly at: string | null }

type TaskStatusJson =
  | { readonly status: "new" }
  | { readonly status: "taken"; readonly claim: Claim | null }
  | { readonly status: "started"; readonly claim: Claim; readonly started: Started }
  | {
    readonly status: "closed"
    readonly claim: Claim | null
    readonly started: Started | null
    readonly outcome: "done" | "failed" | "stopped" | "start-failed" | "dropped"
    readonly reason: string
    readonly landedIn?: string
    readonly pr: string | null
    readonly report: string | null
    readonly answer: typeof DecisionAnswer.Type | null
    readonly closedAt: string
    readonly postedAt: string | null
  }

type TaskJson = {
  readonly id: string
  readonly title: string
  readonly project: string
  readonly kind: TaskKind
  readonly machine: string | null
  readonly parent: string | null
  readonly children: ChildCount | null
  readonly wait: string | null
  readonly waiting: WaitingJson | null
  readonly split: SplitMark | null
  readonly dependsOn: ReadonlyArray<string>
  readonly priority: TaskPriority | null
  readonly created: string
  readonly body: string
  readonly prState: PrState | null
  readonly hold: Hold | null
  readonly parked: ParkedJson | null
  readonly merge?: TaskRecord["merge"]
  readonly retry?: TaskRecord["retry"]
} & TaskStatusJson

interface ParkedJson {
  readonly origin?: Parked["origin"]
  readonly reviewerWait?: { readonly reason: string; readonly reviewers: ReadonlyArray<{ readonly provider: string; readonly model: string }> }
  readonly branch: string
  readonly questions: ReadonlyArray<{ readonly id: string; readonly text: string; readonly asked: string; readonly blocks: boolean; readonly deciderOwns: boolean; readonly answer: typeof DecisionAnswer.Type | null; readonly overturned?: typeof DecisionAnswer.Type }>
}

const parkedAnswers = (answer: Parked["questions"][number]["answer"]) => {
  if (answer === null) return { answer: null }
  const { words, at, decider } = answer
  const replaced = isDeciderAnswer(answer) ? undefined : answer.overturned
  return {
    answer: { words, at, decider },
    ...(replaced === undefined ? {} : { overturned: { words: replaced.words, at: replaced.at, decider: replaced.decider } })
  }
}

const parkedJson = (task: string, parked: Parked, deciderOwns: DeciderOwns): ParkedJson => ({
  ...(parked.origin === undefined ? {} : { origin: parked.origin }),
  ...(parked.reviewerWait === undefined ? {} : { reviewerWait: { reason: parked.reviewerWait.reason, reviewers: parked.reviewerWait.reviewers.map(({ provider, model }) => ({ provider, model })) } }),
  branch: parked.branch,
  questions: parked.questions.map((question) => ({
    id: question.id,
    text: question.text,
    asked: question.asked,
    blocks: question.blocks,
    deciderOwns: deciderOwns(task, question),
    ...parkedAnswers(question.answer)
  }))
})

interface BacklogJson {
  readonly schema: typeof BACKLOG_JSON_SCHEMA
  readonly tasks: ReadonlyArray<TaskJson>
  readonly events: ReadonlyArray<ChatEvent>
  readonly merged: ReadonlyArray<string>
  readonly projects: ReadonlyArray<Project> | null
  readonly room: ReadonlyArray<MachineRoom> | null
}

type BeatJson = { readonly schema: typeof BEAT_JSON_SCHEMA } & BeatReport

const columnCap = 48

const claimJson = (record: TaskRecord): TaskStatusJson => {
  const state = record.state
  switch (state.kind) {
    case "new": {
      return { status: "new" }
    }
    case "taken": {
      return { status: "taken", claim: state.claim }
    }
    case "started": {
      return { status: "started", claim: state.claim, started: state.started }
    }
    case "closed": {
      const ran = ranClosing(record)
      const landedIn = taskLandedIn(record)
      return {
        status: "closed",
        claim: state.claim,
        started: ran?.started ?? null,
        outcome: state.closing.outcome,
        reason: state.closing.reason,
        ...(landedIn === null ? {} : { landedIn }),
        pr: landedIn === null ? fullPrUrl(ran?.pr) ?? fullPrUrl(record.parked?.origin?.pr) : null,
        report: ran?.report ?? null,
        answer: decisionAnswer(record),
        closedAt: state.closedAt,
        postedAt: state.postedAt
      }
    }
  }
}

const roomWaiting = (id: string, beatWaits: BeatWaits | null): WaitingJson => {
  const detail = beatWaits?.reasons.get(id)
  return detail === undefined || beatWaits === null ? { kind: "room", detail: null, at: null } : { kind: "room", detail, at: beatWaits.at }
}

const waitingOf = (record: TaskRecord, view: BacklogView): WaitingJson | null =>
  record.state.kind === "new" ? taskWaiting(record, view.tasks, view.merged, view.deciderOwns) ?? roomWaiting(record.spec.id, view.beatWaits) : null

const taskJson = (record: TaskRecord, view: BacklogView): TaskJson => {
  const waiting = waitingOf(record, view)
  return {
    id: record.spec.id,
    title: record.spec.title,
    project: record.spec.project,
    kind: record.spec.kind,
    machine: record.spec.machine,
    parent: record.spec.parent,
    children: record.spec.kind === "parent" ? childCount(record, view.tasks, view.merged) : null,
    wait: waiting === null || waiting.kind === "room" ? null : waiting.detail,
    waiting,
    split: record.spec.split,
    dependsOn: record.spec.dependsOn,
    priority: record.spec.priority,
    created: record.spec.created,
    body: record.spec.body,
    prState: view.prStates.get(record.spec.id) ?? null,
    hold: record.hold,
    parked: record.parked === null ? null : parkedJson(record.spec.id, record.parked, view.deciderOwns),
    ...(record.merge === undefined ? {} : { merge: record.merge }),
    ...(record.retry === undefined ? {} : { retry: record.retry }),
    ...claimJson(record)
  }
}

export const backlogJson = (view: BacklogView): BacklogJson => ({
  schema: BACKLOG_JSON_SCHEMA,
  tasks: view.tasks.map((record) => taskJson(record, view)),
  events: view.events,
  merged: [...view.merged],
  projects: view.projects.kind === "read" ? view.projects.projects : null,
  room: view.room.kind === "read" ? view.room.room : null
})

export const beatJson = (report: BeatReport): BeatJson => ({ schema: BEAT_JSON_SCHEMA, ...report })

const fit = (cell: string): string => cell.length > columnCap ? cell.slice(0, columnCap - 1) + "~" : cell

const sideBySide = (columns: ReadonlyArray<ReadonlyArray<string>>): string => {
  const fitted = columns.map((column) => column.map(fit))
  const widths = fitted.map((column) => Math.max(...column.map((cell) => cell.length)))
  const height = Math.max(...fitted.map((column) => column.length))
  const lines: Array<string> = []
  for (let row = 0; row < height; row += 1) {
    lines.push(fitted.map((column, index) => (column[row] ?? "").padEnd(widths[index] ?? 0)).join("  ").trimEnd())
  }
  return lines.join("\n")
}

const pinOf = (record: TaskRecord): string => record.spec.machine === null ? "" : " @" + record.spec.machine

const named = (record: TaskRecord): string => record.spec.id + (record.spec.priority === null ? "" : " P" + record.spec.priority) + (record.spec.kind === "ship" ? "" : " " + record.spec.kind) + " " + record.spec.project

const doneOf = (record: TaskRecord, all: ReadonlyArray<TaskRecord>, merged: ReadonlySet<string>): string => {
  if (record.spec.kind !== "parent") {
    return ""
  }
  const count = childCount(record, all, merged)
  return " " + count.done + " of " + count.total + " done"
}

const newCell = (record: TaskRecord, all: ReadonlyArray<TaskRecord>, merged: ReadonlySet<string>): string => {
  const open = record.spec.dependsOn.filter((id) => dependencyWaits(record, all.find((candidate) => candidate.spec.id === id), merged))
  const waits = open.length === 0 ? "" : " waits " + open.join(",")
  const held = isHeld(record) ? " held (" + record.hold.reason + ")" : ""
  const asked = openQuestions(record)
  const parked = asked.length > 0
    ? " parked (" + asked.map((question) => question.id).join(",") + ")"
    : record.parked?.reviewerWait === undefined ? "" : " parked (reviewer room)"
  return named(record) + pinOf(record) + doneOf(record, all, merged) + waits + held + parked + " " + record.spec.title
}

const askedOf = (record: TaskRecord): string => {
  const asked = openQuestions(record)
  return asked.length === 0 ? "" : " asking (" + asked.map((question) => question.id).join(",") + ")"
}

const takenCell = (record: TaskRecord, all: ReadonlyArray<TaskRecord>, merged: ReadonlySet<string>): string => {
  const state = record.state
  if (state.kind === "started") {
    return named(record) + doneOf(record, all, merged) + " on " + state.claim.machine + " started" + askedOf(record)
  }
  const machine = state.kind === "taken" && state.claim !== null ? " on " + state.claim.machine : ""
  return named(record) + doneOf(record, all, merged) + machine + " taken"
}

const closedCell = (record: TaskRecord, all: ReadonlyArray<TaskRecord>, merged: ReadonlySet<string>): string => {
  if (record.state.kind !== "closed") {
    return record.spec.id
  }
  const { closing } = record.state
  return named(record) + doneOf(record, all, merged) + " " + (closing.outcome === "dropped" ? "dropped: " + closing.reason : closing.outcome)
}

const answeredCell = (record: TaskRecord, words: string): string => named(record) + " answered: " + words

const closedCells = (closed: ReadonlyArray<TaskRecord>, all: ReadonlyArray<TaskRecord>, merged: ReadonlySet<string>): ReadonlyArray<string> => {
  const answered = closed.flatMap((record) => {
    const answer = decisionAnswer(record)
    return answer === null ? [] : [{ record, answer }]
  })
  const owner = answered.filter(({ answer }) => answer.decider === "owner").map(({ record, answer }) => answeredCell(record, answer.words))
  const agent = answered.filter(({ answer }) => answer.decider === "agent").flatMap(({ record, answer }) => [answeredCell(record, answer.words), "  basis: " + notRecordedBasis])
  return [
    ...closed.filter((record) => decisionAnswer(record) === null).map((record) => closedCell(record, all, merged)),
    ...(owner.length === 0 ? [] : [deciderHeadings.owner, ...owner]),
    ...(agent.length === 0 ? [] : [deciderHeadings.agent, ...agent])
  ]
}

const projectCells = (projects: ProjectList): ReadonlyArray<string> =>
  projects.kind === "unread"
    ? [projects.reason]
    : projects.projects.map((project) => project.name + " on " + (Object.keys(project.checkouts).join(",") || "no machine"))

const roomCells = (room: RoomList): ReadonlyArray<string> =>
  room.kind === "unread" ? [room.reason] : room.room.map((entry) => entry.machine + " " + entry.busy + " of " + entry.slots + " busy")

const headed = (title: string, cells: ReadonlyArray<string>): ReadonlyArray<string> => [title + " (" + cells.length + ")", ...cells]

export const formatBoard = (view: BacklogView): string => {
  const inState = (...kinds: ReadonlyArray<TaskRecord["state"]["kind"]>) => view.tasks.filter((task) => kinds.includes(task.state.kind))
  return sideBySide([
    headed("NEW", inState("new").map((task) => newCell(task, view.tasks, view.merged))),
    headed("TAKEN", inState("taken", "started").map((task) => takenCell(task, view.tasks, view.merged))),
    ["CLOSED (" + inState("closed").length + ")", ...closedCells(inState("closed"), view.tasks, view.merged)],
    ["PROJECTS", ...projectCells(view.projects), "", "MACHINES", ...roomCells(view.room)]
  ])
}

const parkedLine = (action: Extract<BeatAction, { readonly kind: "parked" | "reviewer-wait" }>): string => {
  if (action.kind === "reviewer-wait") {
    return "parked " + action.task + " from run " + action.run + " on " + action.machine + " until a reviewer has room: " + action.reason
  }
  const waiting = action.questions.length + action.decider.length > 0
  return "parked " + action.task + " on " + action.branch + (waiting ? " for " + answersAwaited(action.questions, action.decider) : "")
}

const actionLine = (action: BeatAction): string => {
  switch (action.kind) {
    case "update": {
      return updateLine(action)
    }
    case "started": {
      return "started " + action.task + " on " + action.machine + " with " + action.account + ", output to " + action.log
    }
    case "start-failed": {
      return "start failed " + action.task + " on " + action.machine + ": " + action.reason
    }
    case "lost": {
      return "skipped " + action.task + ": another beat took it"
    }
    case "given-back": {
      return "gave back " + action.task + ": another beat filled " + action.machine
    }
    case "waits": {
      return "waits " + action.task + ": " + action.reason
    }
    case "renewed": {
      return "renewed the token of " + action.task + " on " + action.machine
    }
    case "renew-failed": {
      return "renew failed " + action.task + " on " + action.machine + ": " + action.reason
    }
    case "closed": {
      return "closed " + action.task + " " + action.outcome + " on " + action.machine + ": " + action.reason + (action.pr === null ? "" : ", PR " + action.pr) +
        (action.report === null ? "" : ", report " + action.report)
    }
    case "retry": {
      return "retry " + action.task + " on " + action.machine + " from run " + action.run
    }
    case "split": {
      return "split " + action.task + " on " + action.machine + " into " + action.children.join(", ") + ": " + action.reason
    }
    case "close-failed": {
      return "close failed " + action.task + " on " + action.machine + ": " + action.reason
    }
    case "parked":
    case "reviewer-wait": {
      return parkedLine(action)
    }
    case "held": {
      return "held " + action.task + " on " + action.machine + ": " + action.reason
    }
    case "asking": {
      return "asking " + action.task + " on " + action.machine + ": the run waits until " + action.until + " for the captain's answer to " + action.questions.join(", ")
    }
    case "answered": {
      return "handed " + action.questions.join(", ") + " to the run of " + action.task + " on " + action.machine
    }
    case "answer-failed": {
      return "cannot hand the answers to the run of " + action.task + " on " + action.machine + ": " + action.reason
    }
    case "stalled": {
      return "stalled " + action.task + " on " + action.machine + ": no output since " + action.since
    }
    case "attention": {
      return "needs the " + action.owner + (action.overdue ? ", overdue" : "") + " " + action.item + ": " + action.text
    }
    case "pr-unread": {
      return "cannot read the PR of " + action.task + " for the chat: " + action.reason
    }
    case "pr-checks": {
      return "PR checks for " + action.task + ": " + action.reason
    }
    case "rebase-queued": {
      return "queued a rebase for " + action.task + " " + action.pr
    }
    case "yolo-merged": {
      return "merged " + action.task + " " + action.pr + " on yolo-green"
    }
    case "yolo-updating": {
      return "updating " + action.task + " " + action.pr + " on yolo-green: requested the branch update, and a later beat merges it once the new head's checks are green"
    }
    case "merge-refused": {
      return "did not merge " + action.task + " on yolo-green: " + action.reason
    }
    case "upstream-seen": {
      return "watching " + action.url + " for " + action.project + ": " + action.state
    }
    case "upstream-changed": {
      return "added " + action.task + " for " + action.project + " as a scout: " + action.url + " changed: " + action.changes.join(", ")
    }
    case "upstream-unread": {
      return "upstream of " + action.project + ": " + action.reason
    }
  }
}

const renewal = (action: BeatAction): boolean =>
  action.kind !== "started" && action.kind !== "start-failed" && action.kind !== "lost" && action.kind !== "given-back" && action.kind !== "waits"

export const formatBeat = (report: BeatReport): string =>
  [
    report.beat + " at " + report.at,
    describeQuota(report.quota, report.perTaskRouting),
    "room: " + (report.room.map((entry) => entry.machine + " " + entry.busy + " of " + entry.slots + " busy").join(", ") || "no machine"),
    ...report.actions.map(actionLine),
    ...(report.actions.every(renewal) ? ["no new task"] : [])
  ].join("\n")
