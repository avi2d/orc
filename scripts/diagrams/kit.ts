export type Tone = "work" | "ask" | "mute"
export type Point = readonly [number, number]

const markNames = ["running", "waiting", "done", "failed", "attention"] as const
export type Mark = (typeof markNames)[number]
type MarkShapes = Readonly<Record<Mark, string>>

export interface Part {
  readonly title: string
  readonly text?: string
  readonly cls?: string
  readonly href?: string
  readonly step?: string
  readonly mark?: Mark
  readonly extra?: (x: number, y: number, w: number) => readonly string[]
  readonly extraHeight?: (w: number) => number
}

type Row = Part | { readonly arrow: Tone; readonly note?: string } | { readonly note: string }

export interface Zone {
  readonly label: string
  readonly rows: readonly Row[]
}

export interface Drawing {
  readonly name: string
  readonly shortCards: readonly string[]
  readonly markup: (style: string, marks: MarkShapes) => string
}

const esc = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")

const rich = (value: string): string =>
  esc(value)
    .split("`")
    .map((part, index) => (index % 2 === 1 ? '<tspan class="code">' + part + "</tspan>" : part))
    .join("")

const widthOf = (value: string, plain: number, code: number): number =>
  value.split("`").reduce((sum, part, index) => sum + part.length * (index % 2 === 1 ? code : plain), 0)

const wrapWith = (value: string, width: number, plain: number, code: number): string[] => {
  const lines: string[] = []
  let line = ""
  let inCode = false
  for (const word of value.split(" ")) {
    const opened = inCode ? "`" + word : word
    const candidate = line === "" ? word : line + " " + word
    if (line !== "" && widthOf(candidate, plain, code) > width) {
      lines.push(inCode ? line + "`" : line)
      line = opened
    } else {
      line = candidate
    }
    if ((word.split("`").length - 1) % 2 === 1) inCode = !inCode
  }
  if (line !== "") lines.push(line)
  return lines
}

const wrapText = (value: string, width: number): string[] => wrapWith(value, width, 6.3, 7.1)
const wrapTitle = (value: string, width: number): string[] => wrapWith(value, width, 7.7, 8.2)

export const text = (x: number, y: number, lines: string | readonly string[], cls = "", anchor = "start", lineHeight = 16): string => {
  const rows = typeof lines === "string" ? [lines] : lines
  const spans = rows.map((row, index) => '<tspan x="' + x + '" dy="' + (index === 0 ? 0 : lineHeight) + '">' + rich(row) + "</tspan>").join("")
  return '<text x="' + x + '" y="' + y + '" class="' + cls + '" text-anchor="' + anchor + '">' + spans + "</text>"
}

const rect = (x: number, y: number, w: number, h: number, cls: string, r = 10): string =>
  '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + r + '" class="' + cls + '"/>'

const circle = (cx: number, cy: number, r: number, cls: string): string => '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" class="' + cls + '"/>'

export const path = (d: string, cls: string): string => '<path d="' + d + '" class="' + cls + '"/>'

const badge = (cx: number, cy: number, label: string, tone: "work" | "ask" = "work"): string =>
  circle(cx, cy, 11, "dot-" + tone) + text(cx, cy + 4.5, label, tone === "work" ? "num" : "num-ask", "middle")

const head = (tip: Point, from: Point, tone: Tone): string => {
  const angle = (Math.atan2(tip[1] - from[1], tip[0] - from[0]) * 180) / Math.PI
  return '<path d="M0,0 L-9,-4.5 L-9,4.5 z" class="head-' + tone + '" transform="translate(' + tip[0] + "," + tip[1] + ") rotate(" + angle + ')"/>'
}

export const arrow = (points: readonly Point[], tone: Tone = "work", both = false): string => {
  const first = points.at(0) ?? [0, 0]
  const second = points.at(1) ?? first
  const last = points.at(-1) ?? first
  const before = points.at(-2) ?? first
  const d = points.map(([x, y], index) => (index === 0 ? "M" : "L") + x + "," + y).join(" ")
  return path(d, tone === "mute" ? "line" : "line-" + tone) + head(last, before, tone) + (both ? head(first, second, tone) : "")
}

export const zone = (x: number, y: number, w: number, h: number, label: string): string => rect(x, y, w, h, "zone", 14) + text(x + 12, y + 21, label, "label")

export const chip = (x: number, y: number, w: number, label: string, cls = "card", h = 26): string =>
  rect(x, y, w, h, cls, 6) + text(x + w / 2, y + h / 2 + 4.5, label, "", "middle")

const markSize = 16

const markSlot = (name: Mark): string => "<!--mark " + name + "-->"

const markSlots = /<!--mark (\w+)-->/g

const isMark = (name: string | undefined): name is Mark => markNames.some((known) => known === name)

const mark = (x: number, y: number, name: Mark): string =>
  '<svg x="' + x + '" y="' + y + '" width="' + markSize + '" height="' + markSize + '" viewBox="0 0 24 24" fill="currentColor" class="mark mark-' + name + '" aria-hidden="true">' + markSlot(name) + "</svg>"

const cardLines = (part: Part, w: number): { title: string[]; body: string[]; indent: number } => {
  const indent = part.step === undefined ? 0 : 28
  const room = w - 24 - (part.href === undefined ? 0 : 14) - (part.mark === undefined ? 0 : markSize + 6)
  return { title: wrapTitle(part.title, room - indent), body: part.text === undefined ? [] : wrapText(part.text, w - 24), indent }
}

const cardHeight = (part: Part, w: number): number => {
  const lines = cardLines(part, w)
  return 14 + lines.title.length * 18 + (lines.body.length === 0 ? 0 : 4 + lines.body.length * 16) + (part.extraHeight?.(w - 24) ?? 0) + 10
}

const shortMark = (reason: string): string => "<!--short " + esc(reason) + "-->"

const shortMarks = /<!--short (.*?)-->/g

export const card = (x: number, y: number, w: number, h: number, part: Part): string => {
  const lines = cardLines(part, w)
  const bodyTop = y + 14 + lines.title.length * 18 + 14
  const inner = [
    rect(x, y, w, h, part.cls ?? "card"),
    part.step === undefined ? "" : badge(x + 23, y + 23, part.step),
    text(x + 12 + lines.indent, y + 28, lines.title, "title", "start", 18),
    lines.body.length === 0 ? "" : text(x + 12, bodyTop, lines.body),
    ...(part.extra === undefined ? [] : part.extra(x + 12, bodyTop + lines.body.length * 16 - (lines.body.length === 0 ? 10 : 4), w - 24)),
    part.mark === undefined ? "" : mark(x + w - 12 - markSize - (part.href === undefined ? 0 : 14), y + 15, part.mark),
    part.href === undefined ? "" : path("M" + (x + w - 19) + "," + (y + 18) + " l5,5.5 l-5,5.5", "line-work")
  ].join("")
  const short = cardHeight(part, w) > h ? shortMark(part.title + " needs " + cardHeight(part, w).toString() + " and has " + h.toString()) : ""
  return short + (part.href === undefined ? inner : '<g data-part="' + part.href + '">' + inner + "</g>")
}

export const svg = (name: string, w: number, h: number, title: string, desc: string, body: readonly string[]): Drawing => {
  const open = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + " " + h + '" class="orc-d" role="img" aria-labelledby="d-' + name + "-title d-" + name + '-desc">'
  const opening = [open, '<title id="d-' + name + '-title">' + esc(title) + "</title>", '<desc id="d-' + name + '-desc">' + esc(desc) + "</desc>"]
  return {
    name,
    shortCards: body.flatMap((piece) => [...piece.matchAll(shortMarks)].map((found) => found[1])),
    markup: (style, marks) =>
      [...opening, "<style>" + style + "</style>", ...body.map((piece) => piece.replaceAll(shortMarks, "").replaceAll(markSlots, (slot, slotName?: string) => (isMark(slotName) ? marks[slotName] : slot))), "</svg>", ""].join("\n")
  }
}

const isPart = (row: Row): row is Part => "title" in row

export const tall = (name: string, title: string, desc: string, zones: readonly Zone[]): Drawing => {
  const body: string[] = []
  let y = 4
  zones.forEach((area, index) => {
    const top = y
    const inner: string[] = []
    y += 32
    for (const row of area.rows) {
      if (isPart(row)) {
        const h = cardHeight(row, 328)
        inner.push(card(16, y, 328, h, row))
        y += h + 8
      } else if ("arrow" in row) {
        y -= 6
        inner.push(arrow([[180, y], [180, y + 20]], row.arrow))
        if (row.note !== undefined) inner.push(text(192, y + 14, row.note, row.arrow === "ask" ? "ask-text" : ""))
        y += 22
      } else {
        const lines = wrapText(row.note, 320)
        inner.push(text(20, y + 10, lines, "ask-text"))
        y += lines.length * 16 + 8
      }
    }
    y += 4
    body.push(zone(4, top, 352, y - top, area.label), ...inner)
    if (index < zones.length - 1) {
      body.push(arrow([[180, y + 3], [180, y + 21]], "work"))
      y += 24
    }
  })
  return svg(name + "-tall", 360, y + 4, title, desc, body)
}

export const bullets = (items: readonly string[]): Pick<Part, "extra" | "extraHeight"> => ({
  extra: (x, y, w) => {
    const drawn: string[] = []
    let top = y + 4
    for (const item of items) {
      const lines = wrapText(item, w - 12)
      drawn.push(circle(x + 3, top + 6, 2, "dot-mute-strong"), text(x + 12, top + 10, lines))
      top += lines.length * 16 + 2
    }
    return drawn
  },
  extraHeight: (w) => items.reduce((sum, item) => sum + wrapText(item, w - 12).length * 16 + 2, 8)
})
