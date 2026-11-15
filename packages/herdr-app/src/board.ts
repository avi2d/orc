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

export const cardBox: { readonly heightPx: number; readonly gapPx: number; readonly padPx: number } = { heightPx: 84, gapPx: 6, padPx: 8 }

export interface LaneView {
  readonly offsetPx: number
  readonly heightPx: number
}

const laneKeys: ReadonlySet<string> = new Set(["up", "down", "pageup", "pagedown", "home", "end"])

const cardStep = cardBox.heightPx + cardBox.gapPx
const cardTop = (index: number): number => cardBox.padPx + index * cardStep

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), Math.max(low, high))

const maxOffset = (view: LaneView, count: number): number =>
  2 * cardBox.padPx + count * cardBox.heightPx + Math.max(0, count - 1) * cardBox.gapPx - view.heightPx

export const clampedLaneView = (view: LaneView, count: number): LaneView =>
  ({ ...view, offsetPx: clamp(view.offsetPx, 0, maxOffset(view, count)) })

export const wheelOffset = (view: LaneView, count: number, deltaY: number): number => {
  const at = clampedLaneView(view, count)
  return clamp(at.offsetPx - deltaY, 0, maxOffset(at, count))
}

const laneTarget = (key: string, view: LaneView): number => {
  const page = Math.max(1, Math.floor(view.heightPx / cardStep))
  const first = Math.ceil((view.offsetPx - cardBox.padPx) / cardStep)
  const last = Math.floor((view.offsetPx + view.heightPx - cardBox.padPx - cardBox.heightPx) / cardStep)
  switch (key) {
    case "up": return first - 1
    case "pageup": return first - page
    case "home": return 0
    case "down": return last + 1
    case "pagedown": return last + page
    default: return Number.POSITIVE_INFINITY
  }
}

// ScrollHandle only offers scroll_to_item, which moves the least distance that shows the whole card, so the next offset follows that rule.
const offsetShowing = (item: number, view: LaneView): number => {
  const top = cardTop(item)
  const bottom = top + cardBox.heightPx
  if (top < view.offsetPx) return top
  return bottom > view.offsetPx + view.heightPx ? bottom - view.heightPx : view.offsetPx
}

export const laneJump = (key: string, view: LaneView, count: number): { readonly item: number; readonly offsetPx: number } | null => {
  if (count === 0 || !laneKeys.has(key)) return null
  const at = clampedLaneView(view, count)
  const item = clamp(laneTarget(key, at), 0, count - 1)
  return { item, offsetPx: clamp(offsetShowing(item, at), 0, maxOffset(at, count)) }
}
