import { Graph, layout as rank } from "@dagrejs/dagre"
import { childrenOf, folds, pathTo, shownLinks, type MapPart, type ShownLink } from "./orc-map"
import { createRouter, touches, type Point, type Rect } from "./route"

interface Size {
  readonly width: number
  readonly height: number
}

interface PlacedPart {
  readonly part: MapPart
  readonly rect: Rect
  readonly open: boolean
  readonly depth: number
}

export interface PlacedLabel {
  readonly text: string
  readonly rect: Rect
}

interface PlacedLink {
  readonly link: ShownLink
  readonly points: readonly Point[]
  readonly label?: PlacedLabel
}

export interface MapLayout {
  readonly parts: readonly PlacedPart[]
  readonly links: readonly PlacedLink[]
  readonly bounds: Rect
}

export interface Measures {
  readonly open: ReadonlySet<string>
  readonly stacked: boolean
  readonly cardWidth: number
  readonly cardHeight: (id: string) => number
  readonly labelSize: (text: string) => Size
}

interface Box {
  readonly size: Size
  readonly parts: readonly PlacedPart[]
}

const headRoom = 40
const edge = 16
const stackGap = 28
const labelGap = 6
const titleHeight = 34
const pageLink = { width: 104, height: 22, inset: 8 }
const detailsButton = { room: 28, size: 24, inset: 7 }

const moved = (box: Box, x: number, y: number): Box => ({
  size: box.size,
  parts: box.parts.map((placed) => ({ ...placed, rect: { ...placed.rect, x: placed.rect.x + x, y: placed.rect.y + y } }))
})

interface Wire {
  readonly from: string
  readonly to: string
  readonly link?: ShownLink
}

const ranked = (members: readonly string[], wires: readonly Wire[], boxes: ReadonlyMap<string, Box>, measures: Measures): Box => {
  const graph = new Graph({ multigraph: true })
  graph.setGraph({ rankdir: "TB", nodesep: 44, ranksep: 44, edgesep: 20, align: "UR", marginx: 0, marginy: 0 })
  // dagre writes x and y onto the node object it is given.
  const centres = new Map(members.map((id) => [id, { x: 0, y: 0, width: boxes.get(id)?.size.width ?? 0, height: boxes.get(id)?.size.height ?? 0 }]))
  for (const [id, centre] of centres) graph.setNode(id, centre)
  wires.forEach((wire, index) => {
    const label = wire.link?.label === undefined ? { width: 0, height: 0 } : measures.labelSize(wire.link.label)
    graph.setEdge(wire.from, wire.to, { ...label, labelpos: "c", weight: wire.link === undefined || wire.link.tone === "work" ? 4 : 1 }, index.toString())
  })
  rank(graph, { constraints: members.slice(1).map((right, index) => ({ left: members[index] ?? right, right })) })
  const parts = members.flatMap((id) => {
    const box = boxes.get(id)
    const at = centres.get(id)
    return box === undefined || at === undefined ? [] : moved(box, at.x - box.size.width / 2, at.y - box.size.height / 2).parts
  })
  const left = Math.min(...parts.map((placed) => placed.rect.x))
  const top = Math.min(...parts.map((placed) => placed.rect.y))
  const right = Math.max(...parts.map((placed) => placed.rect.x + placed.rect.width))
  const bottom = Math.max(...parts.map((placed) => placed.rect.y + placed.rect.height))
  return moved({ parts, size: { width: right - left, height: bottom - top } }, -left, -top)
}

const groupsOf = (members: readonly string[], wires: readonly Wire[]): readonly (readonly string[])[] => {
  const lead = new Map(members.map((id) => [id, id]))
  const leadOf = (id: string): string => {
    const next = lead.get(id) ?? id
    return next === id ? id : leadOf(next)
  }
  for (const wire of wires) lead.set(leadOf(wire.from), leadOf(wire.to))
  const groups = new Map<string, string[]>()
  for (const id of members) groups.set(leadOf(id), [...(groups.get(leadOf(id)) ?? []), id])
  return [...groups.values()]
}

const lineUp = (boxes: readonly Box[], gap: number, down: boolean): Box => {
  const across = Math.max(...boxes.map((box) => (down ? box.size.width : box.size.height)))
  let along = 0
  const placed = boxes.map((box) => {
    const centred = down ? (across - box.size.width) / 2 : 0
    const at = moved(box, down ? centred : along, down ? along : 0)
    along += (down ? box.size.height : box.size.width) + gap
    return at
  })
  return {
    size: down ? { width: across, height: along - gap } : { width: along - gap, height: across },
    parts: placed.flatMap((box) => box.parts)
  }
}

const titleWidth = (part: MapPart): number => 32 + part.title.length * (part.mono === true ? 9 : 8)

const middle = (rect: Rect): Point => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })

const sideLabel = (text: string, size: Size, points: readonly Point[], taken: readonly Rect[], wires: readonly (readonly Point[])[]): PlacedLabel | undefined => {
  const segments = points
    .slice(1)
    .map((end, index) => ({ start: points[index] ?? end, end }))
    .map((segment) => ({ ...segment, length: Math.abs(segment.end.x - segment.start.x) + Math.abs(segment.end.y - segment.start.y) }))
  const shared = (segment: { start: Point; end: Point }): boolean =>
    wires.some((wire) =>
      wire.slice(1).some((end, index) => {
        const start = wire[index] ?? end
        const upright = segment.start.x === segment.end.x
        if (upright !== (start.x === end.x)) return false
        if (upright ? start.x !== segment.start.x : start.y !== segment.start.y) return false
        const low = upright ? Math.min(segment.start.y, segment.end.y) : Math.min(segment.start.x, segment.end.x)
        const high = upright ? Math.max(segment.start.y, segment.end.y) : Math.max(segment.start.x, segment.end.x)
        const otherLow = upright ? Math.min(start.y, end.y) : Math.min(start.x, end.x)
        const otherHigh = upright ? Math.max(start.y, end.y) : Math.max(start.x, end.x)
        return otherLow < high && low < otherHigh
      })
    )
  const lines = [points, ...wires]
  const crossed = (rect: Rect): boolean =>
    lines.some((line) =>
      line.slice(1).some((end, index) => {
        const start = line[index] ?? end
        return touches(rect, { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }, 2)
      })
    )
  const spots = segments
    .toSorted((a, b) => Number(shared(a)) - Number(shared(b)) || b.length - a.length)
    .flatMap((segment) => {
      return [0.5, 0.3, 0.7, 0.15, 0.85].flatMap((share) => {
        const at = { x: segment.start.x + (segment.end.x - segment.start.x) * share, y: segment.start.y + (segment.end.y - segment.start.y) * share }
        return segment.start.x === segment.end.x
          ? [
              { x: at.x + labelGap, y: at.y - size.height / 2, ...size },
              { x: at.x - labelGap - size.width, y: at.y - size.height / 2, ...size }
            ]
          : [
              { x: at.x - size.width / 2, y: at.y - labelGap - size.height, ...size },
              { x: at.x - size.width / 2, y: at.y + labelGap, ...size }
            ]
      })
    })
  const clear = spots.find((spot) => !taken.some((rect) => touches(spot, rect, 3)) && !crossed(spot)) ?? spots.find((spot) => !taken.some((rect) => touches(spot, rect, 3))) ?? spots.at(0)
  return clear === undefined ? undefined : { text, rect: clear }
}

export const layoutMap = (measures: Measures): MapLayout => {
  const shown = shownLinks(measures.open)

  const place = (part: MapPart, depth: number): Box => {
    const size = { width: measures.cardWidth, height: measures.cardHeight(part.id) }
    if (!folds(part.id) || !measures.open.has(part.id)) return { size, parts: [{ part, rect: { x: 0, y: 0, ...size }, open: false, depth }] }
    const inner = childrenOf(part.id)
    const boxes = new Map(inner.map((child) => [child.id, place(child, depth + 1)]))
    const childOf = (id: string): string | undefined => {
      const chain = pathTo(id)
      return chain[depth] === part.id ? chain[depth + 1] : undefined
    }
    const seen = new Set<string>()
    const wires = shown.flatMap((link): Wire[] => {
      const from = childOf(link.from)
      const to = childOf(link.to)
      if (from === undefined || to === undefined || from === to || seen.has(from + ">" + to)) return []
      seen.add(from + ">" + to)
      return [{ from, to, ...(from === link.from && to === link.to ? { link } : {}) }]
    })
    const stack = measures.stacked
      ? lineUp([...boxes.values()], stackGap, true)
      : lineUp(
          groupsOf(
            inner.map((child) => child.id),
            wires
          ).map((members) =>
            ranked(
              members,
              wires.filter((wire) => members.includes(wire.from)),
              boxes,
              measures
            )
          ),
          stackGap,
          true
        )
    const header = titleWidth(part) + detailsButton.room + (part.page === undefined ? 0 : pageLink.width + pageLink.inset * 2)
    const whole = { width: Math.max(stack.size.width + edge * 2, header), height: stack.size.height + headRoom + edge }
    const body = moved(stack, (whole.width - stack.size.width) / 2, headRoom)
    return { size: whole, parts: [{ part, rect: { x: 0, y: 0, ...whole }, open: true, depth }, ...body.parts] }
  }

  const drawn = lineUp(
    childrenOf(undefined).map((group) => place(group, 0)),
    measures.stacked ? 72 : 124,
    measures.stacked
  )
  const opened = drawn.parts.filter((placed) => placed.open)
  const titles = opened.map((placed) => ({ ...placed.rect, width: Math.min(placed.rect.width, titleWidth(placed.part)), height: titleHeight }))
  const pageLinks = opened
    .filter((placed) => placed.part.page !== undefined)
    .map((placed) => ({ x: placed.rect.x + placed.rect.width - detailsButton.room - pageLink.width - pageLink.inset, y: placed.rect.y + pageLink.inset, width: pageLink.width, height: pageLink.height }))
  const infoButtons = opened.map((placed) => ({ x: placed.rect.x + placed.rect.width - detailsButton.inset - detailsButton.size, y: placed.rect.y + detailsButton.inset, width: detailsButton.size, height: detailsButton.size }))
  const cards = drawn.parts.filter((placed) => !placed.open)
  const solid = [...cards.map((placed) => placed.rect), ...titles, ...pageLinks, ...infoButtons]
  const route = createRouter(solid)
  const rectOf = new Map(cards.map((placed) => [placed.part.id, placed.rect]))
  const reach = (link: ShownLink): number => {
    const from = rectOf.get(link.from)
    const to = rectOf.get(link.to)
    if (from === undefined || to === undefined) return 0
    return Math.abs(middle(from).x - middle(to).x) + Math.abs(middle(from).y - middle(to).y)
  }
  const routed = shown
    .toSorted((a, b) => reach(a) - reach(b))
    .flatMap((link): PlacedLink[] => {
      const from = rectOf.get(link.from)
      const to = rectOf.get(link.to)
      return from === undefined || to === undefined ? [] : [{ link, points: route({ id: link.from + " " + link.tone, rect: from }, { id: link.to, rect: to }) }]
    })
  const taken = [...solid]
  const links = routed.map((placed): PlacedLink => {
    if (placed.link.label === undefined) return placed
    const others = routed.filter((other) => other !== placed).map((other) => other.points)
    const label = sideLabel(placed.link.label, measures.labelSize(placed.link.label), placed.points, taken, others)
    if (label === undefined) return placed
    taken.push(label.rect)
    return { ...placed, label }
  })
  const rects = [...drawn.parts.map((placed) => placed.rect), ...links.flatMap((placed) => (placed.label === undefined ? [] : [placed.label.rect]))]
  const points = links.flatMap((placed) => placed.points)
  const left = Math.min(...rects.map((rect) => rect.x), ...points.map((point) => point.x))
  const top = Math.min(...rects.map((rect) => rect.y), ...points.map((point) => point.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.width), ...points.map((point) => point.x))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height), ...points.map((point) => point.y))
  return { parts: drawn.parts, links, bounds: { x: left, y: top, width: right - left, height: bottom - top } }
}
