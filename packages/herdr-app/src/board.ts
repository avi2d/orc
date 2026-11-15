export type Lane = "Backlog" | "Planned" | "Awaiting you" | "Running" | "Done"
export const lanes: ReadonlyArray<Lane> = ["Backlog", "Planned", "Awaiting you", "Running", "Done"]

export interface BoardTask {
  readonly id: string
  readonly title: string
  readonly project: string
  readonly kind: "ship" | "scout" | "task" | "decision" | "parent"
  readonly created: string
  readonly status: "new" | "taken" | "started" | "closed"
  readonly held: boolean
  readonly parked: boolean
  readonly prState: "open" | "closed" | "merged" | null
}

export const kindLabel = (kind: BoardTask["kind"]): string => {
  switch (kind) {
    case "ship": return "Code"
    case "scout": return "Research"
    case "task": return "Ops"
    case "decision": return "Decision"
    case "parent": return "Parent"
  }
}

export const titleClip: { readonly heightPx: number; readonly lineHeightPx: number } = { heightPx: 36, lineHeightPx: 18 }

export const laneFor = (task: BoardTask, attention: ReadonlySet<string>): Lane => {
  if (task.held || task.parked || attention.has(task.id) || (task.status === "closed" && task.prState === "open")) return "Awaiting you"
  if (task.status === "taken" || task.status === "started") return "Running"
  return task.status === "closed" ? "Done" : "Planned"
}

export const tasksInLane = (tasks: ReadonlyArray<BoardTask>, lane: Lane, project: string | null, attention: ReadonlySet<string>): ReadonlyArray<BoardTask> =>
  tasks.filter((task) => (project === null || task.project === project) && laneFor(task, attention) === lane)
    .sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id))

export const clickedSelection = (selected: string | null, clicked: string): string | null => selected === clicked ? null : clicked

export const selectionOnBoard = (selected: string | null, tasks: ReadonlyArray<BoardTask> | null): string | null =>
  selected === null || tasks === null || tasks.some((task) => task.id === selected) ? selected : null
