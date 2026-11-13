import { type BeatAction, type BeatReport, type MachineRoom } from "./beat"
import { taskWait } from "./beat-place"
import { type ChildCount, childCount, dependencyWaits, type TaskKind, answersAwaited, type Claim, type DeciderOwns, type Hold, isHeld, openQuestions, type Parked, type SplitMark, type Started, type TaskRecord } from "../../entities/backlog/index"
import type { Project } from "../../shared/config/index"
import { describeQuota } from "./quota"
import type { ChatEvent } from "../../entities/events/index"

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
  readonly deciderOwns: DeciderOwns
}

type TaskStatusJson =
  | { readonly status: "new" }
  | { readonly status: "taken"; readonly claim: Claim | null }
  | { readonly status: "started"; readonly claim: Claim; readonly started: Started }
  | {
    readonly status: "closed"
    readonly claim: Claim
    readonly started: Started | null
    readonly outcome: "done" | "failed" | "stopped" | "start-failed"
    readonly reason: string
    readonly pr: string | null
    readonly report: string | null
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
  readonly split: SplitMark | null
  readonly dependsOn: ReadonlyArray<string>
  readonly created: string
  readonly hold: Hold | null
  readonly parked: ParkedJson | null
} & TaskStatusJson

interface ParkedJson {
  readonly origin?: Parked["origin"]
  readonly branch: string
  readonly questions: ReadonlyArray<{ readonly id: string; readonly text: string; readonly asked: string; readonly answer: { readonly words: string; readonly at: string } | null }>
}

const parkedJson = (parked: Parked): ParkedJson => ({
  ...(parked.origin === undefined ? {} : { origin: parked.origin }),
  branch: parked.branch,
  questions: parked.questions.map((question) => ({
    id: question.id,
    text: question.text,
    asked: question.asked,
    answer: question.answer === null ? null : { words: question.answer.words, at: question.answer.at }
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
      return {
        status: "closed",
        claim: state.claim,
        started: state.closing.outcome === "start-failed" ? null : state.closing.started,
        outcome: state.closing.outcome,
        reason: state.closing.reason,
        pr: state.closing.outcome === "start-failed" ? null : state.closing.pr,
        report: state.closing.outcome === "start-failed" ? null : state.closing.report,
        closedAt: state.closedAt,
        postedAt: state.postedAt
      }
    }
  }
}

export const backlogJson = (view: BacklogView): BacklogJson => ({
  schema: BACKLOG_JSON_SCHEMA,
  tasks: view.tasks.map((record) => ({
    id: record.spec.id,
    title: record.spec.title,
    project: record.spec.project,
    kind: record.spec.kind,
    machine: record.spec.machine,
    parent: record.spec.parent,
    children: record.spec.kind === "parent" ? childCount(record, view.tasks, view.merged) : null,
    wait: record.state.kind === "new" ? taskWait(record, view.tasks, view.merged, view.deciderOwns) : null,
    split: record.spec.split,
    dependsOn: record.spec.dependsOn,
    created: record.spec.created,
    hold: record.hold,
    parked: record.parked === null ? null : parkedJson(record.parked),
    ...claimJson(record)
  })),
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

const named = (record: TaskRecord): string => record.spec.id + (record.spec.kind === "ship" ? "" : " " + record.spec.kind) + " " + record.spec.project

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
  const parked = asked.length === 0 ? "" : " parked (" + asked.map((question) => question.id).join(",") + ")"
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

const closedCell = (record: TaskRecord, all: ReadonlyArray<TaskRecord>, merged: ReadonlySet<string>): string =>
  record.state.kind === "closed" ? named(record) + doneOf(record, all, merged) + " " + record.state.closing.outcome : record.spec.id

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
    headed("CLOSED", inState("closed").map((task) => closedCell(task, view.tasks, view.merged))),
    ["PROJECTS", ...projectCells(view.projects), "", "MACHINES", ...roomCells(view.room)]
  ])
}

const actionLine = (action: BeatAction): string => {
  switch (action.kind) {
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
    case "split": {
      return "split " + action.task + " on " + action.machine + " into " + action.children.join(", ") + ": " + action.reason
    }
    case "close-failed": {
      return "close failed " + action.task + " on " + action.machine + ": " + action.reason
    }
    case "parked": {
      return "parked " + action.task + " on " + action.branch + " for " + answersAwaited(action.questions, action.decider)
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
    describeQuota(report.quota),
    "room: " + (report.room.map((entry) => entry.machine + " " + entry.busy + " of " + entry.slots + " busy").join(", ") || "no machine"),
    ...report.actions.map(actionLine),
    ...(report.actions.every(renewal) ? ["no new task"] : [])
  ].join("\n")
