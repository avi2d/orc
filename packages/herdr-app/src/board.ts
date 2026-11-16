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

export interface QueuedRun {
  readonly task: string
  readonly machine: string | null
  readonly ahead: number | null
}

export const queueLine = (queued: ReadonlyArray<QueuedRun>, task: string): string | null => {
  const entry = queued.find((candidate) => candidate.task === task)
  if (entry === undefined) return null
  const place = `Queued on ${entry.machine ?? "this machine"}`
  return entry.ahead === null ? place : `${place}, ${entry.ahead} ahead`
}

export const tasksInLane = (tasks: ReadonlyArray<BoardTask>, lane: Lane, project: string | null, attention: ReadonlySet<string>): ReadonlyArray<BoardTask> =>
  tasks.filter((task) => (project === null || task.project === project) && laneFor(task, attention) === lane)
    .sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id))

export const cardBox: { readonly heightPx: number; readonly queuedHeightPx: number; readonly gapPx: number; readonly padPx: number } =
  { heightPx: 84, queuedHeightPx: 106, gapPx: 6, padPx: 8 }

export const cardHeight = (waiting: string | null): number => waiting === null ? cardBox.heightPx : cardBox.queuedHeightPx

export interface LaneView {
  readonly offsetPx: number
  readonly heightPx: number
}

const laneKeys: ReadonlySet<string> = new Set(["up", "down", "pageup", "pagedown", "home", "end"])

const cardStep = cardBox.heightPx + cardBox.gapPx
const cardTop = (heights: ReadonlyArray<number>, index: number): number =>
  heights.slice(0, index).reduce((top, height) => top + height + cardBox.gapPx, cardBox.padPx)

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), Math.max(low, high))

const maxOffset = (view: LaneView, heights: ReadonlyArray<number>): number =>
  2 * cardBox.padPx + heights.reduce((sum, height) => sum + height, 0) + Math.max(0, heights.length - 1) * cardBox.gapPx - view.heightPx

export const clampedLaneView = (view: LaneView, heights: ReadonlyArray<number>): LaneView =>
  ({ ...view, offsetPx: clamp(view.offsetPx, 0, maxOffset(view, heights)) })

export const wheelOffset = (view: LaneView, heights: ReadonlyArray<number>, deltaY: number): number => {
  const at = clampedLaneView(view, heights)
  return clamp(at.offsetPx - deltaY, 0, maxOffset(at, heights))
}

const laneTarget = (key: string, view: LaneView, heights: ReadonlyArray<number>): number => {
  const page = Math.max(1, Math.floor(view.heightPx / cardStep))
  const tops = heights.map((_, index) => cardTop(heights, index))
  const first = tops.findIndex((top) => top >= view.offsetPx)
  const last = tops.reduce((found, top, index) => top + (heights[index] ?? 0) <= view.offsetPx + view.heightPx ? index : found, -1)
  switch (key) {
    case "up": return (first === -1 ? heights.length : first) - 1
    case "pageup": return (first === -1 ? heights.length : first) - page
    case "home": return 0
    case "down": return last + 1
    case "pagedown": return last + page
    default: return Number.POSITIVE_INFINITY
  }
}

// ScrollHandle only offers scroll_to_item, which moves the least distance that shows the whole card, so the next offset follows that rule.
const offsetShowing = (item: number, view: LaneView, heights: ReadonlyArray<number>): number => {
  const top = cardTop(heights, item)
  const bottom = top + (heights[item] ?? 0)
  if (top < view.offsetPx) return top
  return bottom > view.offsetPx + view.heightPx ? bottom - view.heightPx : view.offsetPx
}

export const laneJump = (key: string, view: LaneView, heights: ReadonlyArray<number>): { readonly item: number; readonly offsetPx: number } | null => {
  if (heights.length === 0 || !laneKeys.has(key)) return null
  const at = clampedLaneView(view, heights)
  const item = clamp(laneTarget(key, at, heights), 0, heights.length - 1)
  return { item, offsetPx: clamp(offsetShowing(item, at, heights), 0, maxOffset(at, heights)) }
}

export const clickedSelection = (selected: string | null, clicked: string): string | null => selected === clicked ? null : clicked

export const selectionOnBoard = (selected: string | null, tasks: ReadonlyArray<BoardTask> | null): string | null =>
  selected === null || tasks === null || tasks.some((task) => task.id === selected) ? selected : null

export const panelCommand = (kept: string | null, shown: boolean | null): "layout.show" | "layout.hide" | null =>
  (kept !== null) === shown ? null : kept !== null ? "layout.show" : "layout.hide"
