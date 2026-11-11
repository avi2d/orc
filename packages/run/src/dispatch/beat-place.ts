import { deliveryFor, type RunDelivery } from "../delivery"
import { checkoutOn, type DispatchConfig, type Machine, modeOf, type Project } from "./config"
import { answerWait, type DeciderOwns, type TaskRecord } from "./task-record"

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

const freeRoom = (room: MachineRoom): number => Math.max(0, room.slots - room.busy)

const dependencyOpen = (dependency: TaskRecord | undefined): boolean =>
  dependency === undefined || dependency.state.kind !== "closed" || dependency.state.closing.outcome !== "done"

export interface ChildCount {
  readonly done: number
  readonly total: number
}

const childDone = (child: TaskRecord, merged: ReadonlySet<string>): boolean => {
  if (dependencyOpen(child)) {
    return false
  }
  if (child.spec.kind !== "ship") {
    return true
  }
  const pr = child.state.kind === "closed" && child.state.closing.outcome !== "start-failed" ? child.state.closing.pr : null
  return pr === null || merged.has(child.spec.id)
}

export const childCount = (parent: TaskRecord, tasks: ReadonlyArray<TaskRecord>, merged: ReadonlySet<string>): ChildCount => {
  const children = tasks.filter((task) => task.spec.parent === parent.spec.id)
  return { done: children.filter((child) => childDone(child, merged)).length, total: children.length }
}

const childrenWait = (parent: TaskRecord, tasks: ReadonlyArray<TaskRecord>, merged: ReadonlySet<string>): string | null => {
  const count = childCount(parent, tasks, merged)
  if (count.total === 0) {
    return "waits for its first child"
  }
  return count.done < count.total ? "waits on its children, " + count.done + " of " + count.total + " done" : null
}

export const dependencyWaits = (task: TaskRecord, dependency: TaskRecord | undefined, merged: ReadonlySet<string>): boolean =>
  dependencyOpen(dependency) || (dependency !== undefined && splitSiblingUnmerged(task, dependency, merged))

const splitSiblingUnmerged = (task: TaskRecord, dependency: TaskRecord, merged: ReadonlySet<string>): boolean => {
  if (task.spec.parent === null || task.spec.parent !== dependency.spec.parent) {
    return false
  }
  if (task.spec.kind !== "ship" || dependency.spec.kind !== "ship") {
    return false
  }
  if (dependency.state.kind !== "closed" || dependency.state.closing.outcome === "start-failed") {
    return false
  }
  const pr = dependency.state.closing.pr
  return pr !== null && !merged.has(dependency.spec.id)
}

export const taskWait = (task: TaskRecord, tasks: ReadonlyArray<TaskRecord>, merged: ReadonlySet<string>, deciderOwns: DeciderOwns): string | null => {
  const held = answerWait(task, deciderOwns)
  if (held !== null) {
    return held
  }
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
      return "waits on " + id
    }
  }
  return null
}

export interface Placed {
  readonly kind: "place"
  readonly machine: Machine
  readonly checkout: string
  readonly delivery: RunDelivery
  readonly instructions: string | null
}

type Placement = Placed | { readonly kind: "waits"; readonly reason: string }

interface Candidate {
  readonly machine: Machine
  readonly checkout: string
}

const roomiest = (
  candidates: ReadonlyArray<Candidate>,
  room: ReadonlyArray<MachineRoom>,
  overloaded: ReadonlyMap<string, string>
): { readonly best: Candidate | null; readonly loaded: ReadonlyArray<string> } => {
  let best: (Candidate & { readonly free: number }) | null = null
  const loaded: Array<string> = []
  for (const candidate of candidates) {
    const free = freeRoom(room.find((entry) => entry.machine === candidate.machine.name) ?? { machine: candidate.machine.name, slots: 0, busy: 0 })
    const load = overloaded.get(candidate.machine.name)
    if (load === undefined && free > (best?.free ?? 0)) {
      best = { ...candidate, free }
    } else if (load !== undefined && free > 0) {
      loaded.push(load)
    }
  }
  return { best, loaded }
}

// A task that names a machine is placed there or nowhere, whatever room the other machines have.
export const placeTask = (
  task: TaskRecord,
  config: DispatchConfig,
  projects: ReadonlyArray<Project>,
  room: ReadonlyArray<MachineRoom>,
  overloaded: ReadonlyMap<string, string> = new Map()
): Placement => {
  const project = projects.find((candidate) => candidate.name === task.spec.project)
  if (project === undefined) {
    return { kind: "waits", reason: "the project " + task.spec.project + " is not in the project list" }
  }
  const pinned = task.spec.machine
  if (pinned !== null && !config.machines.some((machine) => machine.name === pinned)) {
    return { kind: "waits", reason: "the machine " + pinned + " is not in dispatch.json" }
  }
  const candidates = config.machines.flatMap((machine) => {
    const checkout = checkoutOn(project, machine.name)
    return (pinned === null || machine.name === pinned) && checkout !== null ? [{ machine, checkout }] : []
  })
  if (candidates.length === 0) {
    return { kind: "waits", reason: "the project " + project.name + " has no checkout on " + (pinned ?? "any machine") }
  }
  const { best, loaded } = roomiest(candidates, room, overloaded)
  if (best === null && loaded.length > 0) {
    return { kind: "waits", reason: loaded.join("; ") }
  }
  if (best === null) {
    return { kind: "waits", reason: pinned === null ? "no machine with a checkout of " + project.name + " has room" : pinned + " has no room" }
  }
  return {
    kind: "place",
    machine: best.machine,
    checkout: best.checkout,
    delivery: deliveryFor(modeOf(project), task.spec.internal),
    instructions: project.instructions ?? null
  }
}
