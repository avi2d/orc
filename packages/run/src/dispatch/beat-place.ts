import { checkoutOn, type DispatchConfig, type Machine, type Project } from "./config"
import type { TaskRecord } from "./task-record"

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

export const dependencyOpen = (dependency: TaskRecord | undefined): boolean =>
  dependency === undefined || dependency.state.kind !== "closed" || dependency.state.closing.outcome !== "done"

type Placement =
  | { readonly kind: "place"; readonly machine: Machine; readonly checkout: string }
  | { readonly kind: "waits"; readonly reason: string }

// A task that names a machine is placed there or nowhere, whatever room the other machines have.
export const placeTask = (
  task: TaskRecord,
  config: DispatchConfig,
  projects: ReadonlyArray<Project>,
  room: ReadonlyArray<MachineRoom>
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
  let best: { readonly machine: Machine; readonly checkout: string; readonly free: number } | null = null
  for (const candidate of candidates) {
    const free = freeRoom(room.find((entry) => entry.machine === candidate.machine.name) ?? { machine: candidate.machine.name, slots: 0, busy: 0 })
    if (free > (best?.free ?? 0)) {
      best = { ...candidate, free }
    }
  }
  if (best === null) {
    return { kind: "waits", reason: pinned === null ? "no machine with a checkout of " + project.name + " has room" : pinned + " has no room" }
  }
  return { kind: "place", machine: best.machine, checkout: best.checkout }
}
