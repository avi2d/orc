import { dependencyOpen, type BeatAction, type BeatReport, type MachineRoom } from "./beat"
import type { Project } from "./config"
import { describeQuota } from "./quota"
import type { Claim, Started, TaskRecord } from "./task-record"

const BACKLOG_JSON_SCHEMA = "orc.backlog.v1" as const
const BEAT_JSON_SCHEMA = "orc.beat.v1" as const

export type ProjectList = { readonly kind: "read"; readonly projects: ReadonlyArray<Project> } | { readonly kind: "unread"; readonly reason: string }
export type RoomList = { readonly kind: "read"; readonly room: ReadonlyArray<MachineRoom> } | { readonly kind: "unread"; readonly reason: string }

export interface BacklogView {
  readonly tasks: ReadonlyArray<TaskRecord>
  readonly projects: ProjectList
  readonly room: RoomList
}

type TaskStatusJson =
  | { readonly status: "new" }
  | { readonly status: "taken"; readonly claim: Claim | null }
  | { readonly status: "started"; readonly claim: Claim; readonly started: Started }
  | {
    readonly status: "closed"
    readonly claim: Claim
    readonly started: Started | null
    readonly outcome: "done" | "failed" | "start-failed"
    readonly reason: string
    readonly closedAt: string
  }

type TaskJson = {
  readonly id: string
  readonly title: string
  readonly project: string
  readonly machine: string | null
  readonly dependsOn: ReadonlyArray<string>
  readonly created: string
} & TaskStatusJson

interface BacklogJson {
  readonly schema: typeof BACKLOG_JSON_SCHEMA
  readonly tasks: ReadonlyArray<TaskJson>
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
        closedAt: state.closedAt
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
    machine: record.spec.machine,
    dependsOn: record.spec.dependsOn,
    created: record.spec.created,
    ...claimJson(record)
  })),
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

const newCell = (record: TaskRecord, all: ReadonlyArray<TaskRecord>): string => {
  const open = record.spec.dependsOn.filter((id) => dependencyOpen(all.find((candidate) => candidate.spec.id === id)))
  const waits = open.length === 0 ? "" : " waits " + open.join(",")
  return record.spec.id + " " + record.spec.project + pinOf(record) + waits + " " + record.spec.title
}

const takenCell = (record: TaskRecord): string => {
  const state = record.state
  if (state.kind === "started") {
    return record.spec.id + " " + record.spec.project + " on " + state.claim.machine + " started"
  }
  const machine = state.kind === "taken" && state.claim !== null ? " on " + state.claim.machine : ""
  return record.spec.id + " " + record.spec.project + machine + " taken"
}

const closedCell = (record: TaskRecord): string =>
  record.state.kind === "closed" ? record.spec.id + " " + record.spec.project + " " + record.state.closing.outcome : record.spec.id

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
    headed("NEW", inState("new").map((task) => newCell(task, view.tasks))),
    headed("TAKEN", inState("taken", "started").map(takenCell)),
    headed("CLOSED", inState("closed").map(closedCell)),
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
      return "closed " + action.task + " " + action.outcome + " on " + action.machine + ": " + action.reason
    }
  }
}

const renewal = (action: BeatAction): boolean => action.kind === "renewed" || action.kind === "renew-failed"

export const formatBeat = (report: BeatReport): string =>
  [
    report.beat + " at " + report.at,
    describeQuota(report.quota),
    "room: " + (report.room.map((entry) => entry.machine + " " + entry.busy + " of " + entry.slots + " busy").join(", ") || "no machine"),
    ...report.actions.map(actionLine),
    ...(report.actions.every(renewal) ? ["no new task"] : [])
  ].join("\n")
