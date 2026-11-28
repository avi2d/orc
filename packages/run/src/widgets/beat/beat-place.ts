import { Effect, type FileSystem } from "effect"
import type { BeatAction } from "../../entities/attention/index"
import { deliveryFor, type RunDelivery } from "../../shared/config/index"
import { checkoutOn, type DispatchConfig, type Machine, modeOf, type Project } from "../../shared/config/index"
import { answerWait, type BacklogError, closedUndone, decisionWait, type DeciderOwns, listTasks, type TaskFileError, type TaskRecord, childCount, dependencyWaits, isHeld, missingOriginWait, taskPriorities } from "../../entities/backlog/index"

export interface MachineRoom {
  readonly machine: string
  readonly slots: number
  readonly busy: number
}

export const readRoom = (machines: ReadonlyArray<Machine>, tasks: ReadonlyArray<TaskRecord>): ReadonlyArray<MachineRoom> =>
  machines.map((machine) => ({
    machine: machine.name,
    slots: machine.slots,
    busy: tasks.filter((task) =>
      (task.state.kind === "taken" || task.state.kind === "started") && task.state.claim?.machine === machine.name
    ).length
  }))

// Each beat writes its claim before it counts, so of two beats racing for a machine's last slot at least one sees both claims.
export const machineOverfull = (
  root: string,
  machine: Machine
): Effect.Effect<boolean, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  listTasks(root).pipe(
    Effect.map((tasks) => readRoom([machine], tasks).some((entry) => entry.busy > entry.slots))
  )

const priorityRank = (task: TaskRecord): number => task.spec.priority ?? taskPriorities.length

const startOrder = (left: TaskRecord, right: TaskRecord): number =>
  priorityRank(left) - priorityRank(right) ||
  left.spec.created.localeCompare(right.spec.created) ||
  left.spec.id.localeCompare(right.spec.id, "en", { numeric: true })

export const startable = (tasks: ReadonlyArray<TaskRecord>, closed: ReadonlyArray<BeatAction>): ReadonlyArray<TaskRecord> => {
  const retried = new Set(closed.flatMap((action) => action.kind === "retry" ? [action.task] : []))
  return tasks.filter((task) => task.state.kind === "new" && !retried.has(task.spec.id)).toSorted(startOrder)
}

const freeRoom = (room: MachineRoom): number => Math.max(0, room.slots - room.busy)

const undoneNote = (closed: ReadonlyArray<TaskRecord>): string =>
  closed.length === 0
    ? ""
    : ", and " + closed.map((task) => task.spec.id + " closed " + closedUndone(task)).join(", ") + ", which no beat reopens"

const childrenWait = (parent: TaskRecord, tasks: ReadonlyArray<TaskRecord>, merged: ReadonlySet<string>): string | null => {
  const count = childCount(parent, tasks, merged)
  if (count.total === 0) {
    return "waits for its first child"
  }
  const undone = tasks.filter((task) => task.spec.parent === parent.spec.id && closedUndone(task) !== null)
  return count.done < count.total ? "waits on its children, " + count.done + " of " + count.total + " done" + undoneNote(undone) : null
}

const parkedOriginWait = (task: TaskRecord): string | null =>
  task.parked !== null && task.parked.origin === undefined
    ? missingOriginWait(task.spec.id)
    : null

export interface TaskWait {
  readonly kind: "no-priority" | "decision" | "held" | "parked" | "depends"
  readonly detail: string
}

const dependsWait = (task: TaskRecord, tasks: ReadonlyArray<TaskRecord>, merged: ReadonlySet<string>): string | null => {
  const children = task.spec.kind === "parent" ? childrenWait(task, tasks, merged) : null
  if (children !== null) {
    return children
  }
  for (const id of task.spec.dependsOn) {
    const dependency = tasks.find((candidate) => candidate.spec.id === id)
    if (dependency === undefined) {
      return "waits on " + id + ", which the backlog does not hold"
    }
    if (dependencyWaits(task, dependency, merged)) {
      return "waits on " + id + undoneNote(closedUndone(dependency) === null ? [] : [dependency])
    }
  }
  return null
}

export const taskWaiting = (task: TaskRecord, tasks: ReadonlyArray<TaskRecord>, merged: ReadonlySet<string>, deciderOwns: DeciderOwns): TaskWait | null => {
  if (task.spec.kind === "decision") {
    return { kind: "decision", detail: decisionWait }
  }
  if (task.spec.priority === null) {
    return { kind: "no-priority", detail: "no priority" }
  }
  const answer = answerWait(task, deciderOwns)
  if (answer !== null) {
    return { kind: isHeld(task) ? "held" : "parked", detail: answer }
  }
  const origin = parkedOriginWait(task)
  if (origin !== null) {
    return { kind: "parked", detail: origin }
  }
  const depends = dependsWait(task, tasks, merged)
  return depends === null ? null : { kind: "depends", detail: depends }
}

export const taskWait = (task: TaskRecord, tasks: ReadonlyArray<TaskRecord>, merged: ReadonlySet<string>, deciderOwns: DeciderOwns): string | null =>
  taskWaiting(task, tasks, merged, deciderOwns)?.detail ?? null

export interface Placed {
  readonly kind: "place"
  readonly machine: Machine
  readonly checkout: string
  readonly delivery: RunDelivery
  readonly instructions: string | null
}

type MachineRejection = "unknown-project" | "priority-floor" | "missing-origin" | "parked-origin" | "pin" | "pin-required" | "no-checkout" | "capacity" | "load"

interface RejectedMachine {
  readonly kind: "rejected"
  readonly machine: string
  readonly code: MachineRejection
  readonly reason: string
}

export type MachinePlacement = { readonly kind: "eligible"; readonly machine: string } | RejectedMachine

type PlacementWait = { readonly kind: "waits"; readonly reason: string }
type Placement = (Placed | PlacementWait) & { readonly machines: ReadonlyArray<MachinePlacement> }

interface EligibleMachine {
  readonly kind: "eligible"
  readonly machine: Machine
  readonly checkout: string
  readonly free: number
}

type MachineAssessment = EligibleMachine | RejectedMachine

interface MachineRestriction {
  readonly machine: string
  readonly code: "parked-origin" | "pin"
}

const restrictedMachine = (task: Pick<TaskRecord, "parked" | "spec">): MachineRestriction | null => {
  const origin = task.parked?.origin
  if (origin !== undefined) {
    return { machine: origin.machine, code: "parked-origin" }
  }
  return task.spec.machine === null ? null : { machine: task.spec.machine, code: "pin" }
}

const rejectMachine = (machine: string, code: MachineRejection, reason: string): RejectedMachine =>
  ({ kind: "rejected", machine, code, reason })

const rejectPlacement = (
  machines: ReadonlyArray<Machine>,
  code: MachineRejection,
  reason: string
): PlacementWait & { readonly machines: ReadonlyArray<RejectedMachine> } =>
  ({ kind: "waits", reason, machines: machines.map((machine) => rejectMachine(machine.name, code, reason)) })

const checkoutMissing = (project: string, machine: string): string =>
  "the project " + project + " has no checkout on " + machine

const noRoom = (machine: string): string => machine + " has no room"

const assessMachine = (
  machine: Machine,
  project: Project,
  restriction: MachineRestriction | null,
  room: ReadonlyArray<MachineRoom>,
  overloaded: ReadonlyMap<string, string>
): MachineAssessment => {
  if (restriction !== null && machine.name !== restriction.machine) {
    const reason = restriction.code === "parked-origin" ? "the task is parked on " : "the task is pinned to "
    return rejectMachine(machine.name, restriction.code, reason + restriction.machine)
  }
  const checkout = checkoutOn(project, machine.name)
  if (checkout === null) {
    return rejectMachine(machine.name, "no-checkout", checkoutMissing(project.name, machine.name))
  }
  if (machine.pinnedOnly === true && restriction === null) {
    return rejectMachine(machine.name, "pin-required", machine.name + " only runs tasks pinned to it")
  }
  const slot = room.find((entry) => entry.machine === machine.name)
  const free = slot === undefined ? 0 : freeRoom(slot)
  if (free === 0) {
    return rejectMachine(machine.name, "capacity", noRoom(machine.name))
  }
  const load = overloaded.get(machine.name)
  if (load !== undefined) {
    return rejectMachine(machine.name, "load", load)
  }
  return { kind: "eligible", machine, checkout, free }
}

const roomiest = (assessments: ReadonlyArray<MachineAssessment>): EligibleMachine | null => {
  let best: EligibleMachine | null = null
  for (const assessment of assessments) {
    if (assessment.kind === "eligible" && assessment.free > (best?.free ?? 0)) {
      best = assessment
    }
  }
  return best
}

const machinePlacement = (assessment: MachineAssessment): MachinePlacement =>
  assessment.kind === "eligible" ? { kind: "eligible", machine: assessment.machine.name } : assessment

const placementWait = (project: string, pinned: string | undefined, machines: ReadonlyArray<MachinePlacement>): string => {
  const loaded = machines.flatMap((machine) => machine.kind === "rejected" && machine.code === "load" ? [machine.reason] : [])
  if (loaded.length > 0) {
    return loaded.join("; ")
  }
  if (machines.some((machine) => machine.kind === "rejected" && machine.code === "capacity")) {
    return pinned === undefined ? "no machine with a checkout of " + project + " has room" : noRoom(pinned)
  }
  const pinRequired = machines.flatMap((machine) => machine.kind === "rejected" && machine.code === "pin-required" ? [machine.reason] : [])
  return pinRequired.length > 0 ? pinRequired.join("; ") : checkoutMissing(project, pinned ?? "any machine")
}

export const placeTask = (
  task: TaskRecord,
  config: Pick<DispatchConfig, "machines">,
  projects: ReadonlyArray<Project>,
  room: ReadonlyArray<MachineRoom>,
  overloaded: ReadonlyMap<string, string> = new Map()
): Placement => {
  const project = projects.find((candidate) => candidate.name === task.spec.project)
  if (project === undefined) {
    return rejectPlacement(config.machines, "unknown-project", "the project " + task.spec.project + " is not in the project list")
  }
  if (project.floor !== undefined && task.spec.priority !== null && task.spec.priority > project.floor) {
    return rejectPlacement(config.machines, "priority-floor", "P" + task.spec.priority + " is under the floor P" + project.floor + " of the project " + project.name)
  }
  const originWait = parkedOriginWait(task)
  if (originWait !== null) {
    return rejectPlacement(config.machines, "missing-origin", originWait)
  }
  const restriction = restrictedMachine(task)
  if (restriction !== null && !config.machines.some((machine) => machine.name === restriction.machine)) {
    return rejectPlacement(config.machines, restriction.code, "the machine " + restriction.machine + " is not in dispatch.json")
  }
  const assessments = config.machines.map((machine) => assessMachine(machine, project, restriction, room, overloaded))
  const machines = assessments.map(machinePlacement)
  const best = roomiest(assessments)
  if (best === null) {
    return { kind: "waits", reason: placementWait(project.name, restriction?.machine, machines), machines }
  }
  return {
    kind: "place",
    machine: best.machine,
    checkout: best.checkout,
    delivery: deliveryFor(modeOf(project), task.spec.internal),
    instructions: project.instructions ?? null,
    machines
  }
}
