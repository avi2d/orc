export interface Point {
  readonly x: number
  readonly y: number
}

export interface Rect extends Point {
  readonly width: number
  readonly height: number
}

interface End {
  readonly id: string
  readonly rect: Rect
}

export type Route = (from: End, to: End) => readonly Point[]

type Direction = 0 | 1 | 2 | 3

const clearance = 12
const lane = 16
const bendCost = 36
const foreignCost = 5

const directions: readonly Direction[] = [0, 1, 2, 3]
const stepX = [1, 0, -1, 0] as const
const stepY = [0, 1, 0, -1] as const
const opposite = [2, 3, 0, 1] as const

export const touches = (a: Rect, b: Rect, pad = 0): boolean =>
  a.x < b.x + b.width + pad && b.x < a.x + a.width + pad && a.y < b.y + b.height + pad && b.y < a.y + a.height + pad

const whole = (rect: Rect): Rect => ({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) })

const gridLines = (spans: readonly (readonly [start: number, size: number])[]): readonly number[] => {
  const marks = new Set<number>()
  for (const [start, size] of spans) {
    marks.add(start - clearance)
    marks.add(start + Math.round(size / 2))
    marks.add(start + size + clearance)
  }
  const sorted = [...marks].toSorted((a, b) => a - b)
  return sorted.flatMap((mark, index) => {
    if (index === 0) return [mark]
    const before = sorted[index - 1]
    const steps = Math.floor((mark - before) / lane)
    const between = Array.from({ length: Math.max(0, steps - 1) }, (_, step) => Math.round(before + ((mark - before) * (step + 1)) / steps))
    return [...between, mark]
  })
}

interface Heap {
  readonly push: (priority: number, value: number) => void
  readonly pop: () => number | undefined
}

const heap = (): Heap => {
  const priorities: number[] = []
  const values: number[] = []
  const swap = (a: number, b: number): void => {
    const priority = priorities[a] ?? 0
    const value = values[a] ?? 0
    priorities[a] = priorities[b] ?? 0
    values[a] = values[b] ?? 0
    priorities[b] = priority
    values[b] = value
  }
  return {
    push: (priority, value) => {
      priorities.push(priority)
      values.push(value)
      let at = priorities.length - 1
      while (at > 0) {
        const parent = (at - 1) >> 1
        if ((priorities[parent] ?? 0) <= (priorities[at] ?? 0)) break
        swap(at, parent)
        at = parent
      }
    },
    pop: () => {
      const top = values[0]
      const lastPriority = priorities.pop()
      const lastValue = values.pop()
      if (priorities.length > 0 && lastPriority !== undefined && lastValue !== undefined) {
        priorities[0] = lastPriority
        values[0] = lastValue
        let at = 0
        for (;;) {
          const left = at * 2 + 1
          const right = left + 1
          let least = at
          if ((priorities[left] ?? Infinity) < (priorities[least] ?? Infinity)) least = left
          if ((priorities[right] ?? Infinity) < (priorities[least] ?? Infinity)) least = right
          if (least === at) break
          swap(at, least)
          at = least
        }
      }
      return top
    }
  }
}

interface Side {
  readonly border: Point
  readonly port: Point
  readonly out: Direction
}

const sideMiddles = (rect: Rect): readonly [Side, Side, Side, Side] => {
  const midX = rect.x + Math.round(rect.width / 2)
  const midY = rect.y + Math.round(rect.height / 2)
  return [
    { border: { x: rect.x + rect.width, y: midY }, port: { x: rect.x + rect.width + clearance, y: midY }, out: 0 },
    { border: { x: midX, y: rect.y + rect.height }, port: { x: midX, y: rect.y + rect.height + clearance }, out: 1 },
    { border: { x: rect.x, y: midY }, port: { x: rect.x - clearance, y: midY }, out: 2 },
    { border: { x: midX, y: rect.y }, port: { x: midX, y: rect.y - clearance }, out: 3 }
  ]
}

const inLine = (a: Point, b: Point, c: Point): boolean => (a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)

const straightened = (points: readonly Point[]): readonly Point[] =>
  points.filter((point, index) => index === 0 || index === points.length - 1 || !inLine(points[index - 1], point, points[index + 1]))

interface Grid {
  readonly xs: readonly number[]
  readonly ys: readonly number[]
  readonly columns: number
  readonly xIndex: ReadonlyMap<number, number>
  readonly yIndex: ReadonlyMap<number, number>
  readonly blocked: Uint8Array
}

const within = (value: number, start: number, size: number): boolean => value > start - clearance && value < start + size + clearance

const gridOf = (solid: readonly Rect[]): Grid => {
  const xs = gridLines(solid.map((rect) => [rect.x, rect.width]))
  const ys = gridLines(solid.map((rect) => [rect.y, rect.height]))
  const blocked = new Uint8Array(xs.length * ys.length)
  for (const rect of solid) {
    const columns = xs.flatMap((x, column) => (within(x, rect.x, rect.width) ? [column] : []))
    const rows = ys.flatMap((y, row) => (within(y, rect.y, rect.height) ? [row] : []))
    for (const row of rows) for (const column of columns) blocked[row * xs.length + column] = 1
  }
  return { xs, ys, columns: xs.length, xIndex: new Map(xs.map((x, index) => [x, index])), yIndex: new Map(ys.map((y, index) => [y, index])), blocked }
}

const pointOf = (grid: Grid, cell: number): Point => ({ x: grid.xs[cell % grid.columns], y: grid.ys[Math.floor(cell / grid.columns)] })

const freeCell = (grid: Grid, point: Point): number | undefined => {
  const column = grid.xIndex.get(point.x)
  const row = grid.yIndex.get(point.y)
  if (column === undefined || row === undefined) return undefined
  const cell = row * grid.columns + column
  return grid.blocked[cell] === 1 ? undefined : cell
}

const neighbour = (grid: Grid, cell: number, direction: Direction): number | undefined => {
  const column = (cell % grid.columns) + stepX[direction]
  const row = Math.floor(cell / grid.columns) + stepY[direction]
  if (column < 0 || column >= grid.columns || row < 0 || row >= grid.ys.length) return undefined
  const next = row * grid.columns + column
  return grid.blocked[next] === 1 ? undefined : next
}

const trackOf = (grid: Grid, cell: number, direction: Direction): number => {
  const first = direction === 2 ? cell - 1 : direction === 3 ? cell - grid.columns : cell
  return first * 2 + (direction % 2)
}

interface Goal {
  readonly into: Direction
  readonly border: Point
}

interface Trip {
  readonly from: string
  readonly to: string
}

interface Search {
  readonly grid: Grid
  readonly trip: Trip
  readonly goals: ReadonlyMap<number, Goal>
  readonly target: Rect
  readonly users: ReadonlyMap<number, readonly Trip[]>
  readonly cost: Float64Array
  readonly cameFrom: Int32Array
  readonly open: Heap
}

const stateOf = (cell: number, direction: Direction): number => cell * 4 + direction

const headingOf = (state: number): Direction => directions[state & 3]

const reach = (search: Search, cell: number): number => {
  const { x, y } = pointOf(search.grid, cell)
  const { target } = search
  return Math.max(target.x - x, 0, x - target.x - target.width) + Math.max(target.y - y, 0, y - target.y - target.height)
}

const improve = (search: Search, state: number, total: number, before: number): void => {
  if (total >= search.cost[state]) return
  search.cost[state] = total
  search.cameFrom[state] = before
  search.open.push(total + reach(search, state >> 2), state)
}

const shared = (search: Search, track: number): boolean => (search.users.get(track) ?? []).some((user) => user.from !== search.trip.from && user.to !== search.trip.to)

const advance = (search: Search, state: number, next: Direction): void => {
  const cell = state >> 2
  const nextCell = neighbour(search.grid, cell, next)
  if (nextCell === undefined) return
  const here = pointOf(search.grid, cell)
  const there = pointOf(search.grid, nextCell)
  const length = Math.abs(there.x - here.x) + Math.abs(there.y - here.y)
  const bend = next === headingOf(state) ? 0 : bendCost
  const crowd = shared(search, trackOf(search.grid, cell, next)) ? length * foreignCost + bendCost : 0
  improve(search, stateOf(nextCell, next), search.cost[state] + length + bend + crowd, state)
}

const arrived = (search: Search, state: number): boolean => {
  const goal = search.goals.get(state >> 2)
  if (goal === undefined) return false
  if (goal.into === headingOf(state)) return true
  if (headingOf(state) !== opposite[goal.into]) improve(search, stateOf(state >> 2, goal.into), search.cost[state] + bendCost, state)
  return false
}

const explore = (search: Search): number | undefined => {
  for (let state = search.open.pop(); state !== undefined; state = search.open.pop()) {
    if (arrived(search, state)) return state
    for (const next of directions) if (next !== opposite[headingOf(state)]) advance(search, state, next)
  }
  return undefined
}

const traced = (search: Search, found: number): { readonly cells: readonly Point[]; readonly start: number; readonly tracks: readonly number[] } => {
  const cells: Point[] = []
  const tracks: number[] = []
  let state = found
  for (;;) {
    const point = pointOf(search.grid, state >> 2)
    const last = cells.at(-1)
    if (last?.x !== point.x || last.y !== point.y) cells.push(point)
    const before = search.cameFrom[state]
    if (before === -1) return { cells, start: state, tracks }
    if (before >> 2 !== state >> 2) tracks.push(trackOf(search.grid, before >> 2, headingOf(state)))
    state = before
  }
}

const direct = (starts: readonly [Side, ...Side[]], ends: readonly [Side, ...Side[]]): readonly Point[] => {
  const far = (start: Side, end: Side): number => Math.abs(start.border.x - end.border.x) + Math.abs(start.border.y - end.border.y)
  const pairs = starts.flatMap((start) => ends.map((end) => ({ start, end })))
  const nearest = pairs.reduce((best, pair) => (far(pair.start, pair.end) < far(best.start, best.end) ? pair : best), { start: starts[0], end: ends[0] })
  return [nearest.start.border, nearest.end.border]
}

// Every end handed to the route is one of the obstacles, so its ports sit on grid lines.
export const createRouter = (obstacles: readonly Rect[]): Route => {
  const grid = gridOf(obstacles.map(whole))
  const users = new Map<number, Trip[]>()

  return (from, to) => {
    const starts = sideMiddles(whole(from.rect))
    const ends = sideMiddles(whole(to.rect))
    const goals = new Map(
      ends.flatMap((end): [number, Goal][] => {
        const cell = freeCell(grid, end.port)
        return cell === undefined ? [] : [[cell, { into: opposite[end.out], border: end.border }]]
      })
    )
    const search: Search = {
      grid,
      trip: { from: from.id, to: to.id },
      goals,
      target: whole(to.rect),
      users,
      cost: new Float64Array(grid.blocked.length * 4).fill(Infinity),
      cameFrom: new Int32Array(grid.blocked.length * 4).fill(-1),
      open: heap()
    }
    const borders = new Map<number, Point>()
    for (const start of starts) {
      const cell = freeCell(grid, start.port)
      if (cell === undefined) continue
      const state = stateOf(cell, start.out)
      search.cost[state] = clearance
      borders.set(state, start.border)
      search.open.push(clearance + reach(search, cell), state)
    }
    const found = explore(search)
    if (found === undefined) return direct(starts, ends)
    const path = traced(search, found)
    for (const track of path.tracks) users.set(track, [...(users.get(track) ?? []), search.trip])
    const last = goals.get(found >> 2)?.border
    const first = borders.get(path.start)
    return straightened([...(first === undefined ? [] : [first]), ...path.cells.toReversed(), ...(last === undefined ? [] : [last])])
  }
}

export const roundedPath = (points: readonly Point[], radius: number): string =>
  points
    .map((point, index) => {
      if (index === 0) return "M" + point.x.toString() + " " + point.y.toString()
      if (index === points.length - 1) return "L" + point.x.toString() + " " + point.y.toString()
      const before = points[index - 1]
      const after = points[index + 1]
      const inLength = Math.hypot(point.x - before.x, point.y - before.y)
      const outLength = Math.hypot(after.x - point.x, after.y - point.y)
      const cut = Math.min(radius, inLength / 2, outLength / 2)
      if (cut < 1) return "L" + point.x.toString() + " " + point.y.toString()
      const startX = point.x - ((point.x - before.x) / inLength) * cut
      const startY = point.y - ((point.y - before.y) / inLength) * cut
      const endX = point.x + ((after.x - point.x) / outLength) * cut
      const endY = point.y + ((after.y - point.y) / outLength) * cut
      return "L" + startX.toFixed(1) + " " + startY.toFixed(1) + "Q" + point.x.toString() + " " + point.y.toString() + " " + endX.toFixed(1) + " " + endY.toFixed(1)
    })
    .join("")
