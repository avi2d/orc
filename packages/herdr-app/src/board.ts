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

export const titleLines = 2

export const clipTitle = (title: string): string => {
  const lines = title.split("\n")
  return lines.length > titleLines ? lines.slice(0, titleLines).join("\n") : title
}

export const laneFor = (task: BoardTask, attention: ReadonlySet<string>): Lane => {
  if (task.held || task.parked || attention.has(task.id) || (task.status === "closed" && task.prState === "open")) return "Awaiting you"
  if (task.status === "taken" || task.status === "started") return "Running"
  return task.status === "closed" ? "Done" : "Planned"
}

export const tasksInLane = (tasks: ReadonlyArray<BoardTask>, lane: Lane, project: string | null, attention: ReadonlySet<string>): ReadonlyArray<BoardTask> =>
  tasks.filter((task) => (project === null || task.project === project) && laneFor(task, attention) === lane)
    .sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id))
