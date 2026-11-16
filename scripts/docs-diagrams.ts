import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const out = join(import.meta.dir, "..", "docs", "diagrams")
const style = readFileSync(join(out, "diagram.css"), "utf8")

type Lines = string | readonly string[]
type Tone = "work" | "ask" | "mute"

const esc = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")

const rich = (value: string): string =>
  esc(value)
    .split("`")
    .map((part, index) => (index % 2 === 1 ? '<tspan class="code">' + part + "</tspan>" : part))
    .join("")

const text = (x: number, y: number, lines: Lines, cls = "", anchor = "start", lineHeight = 17): string => {
  const rows = typeof lines === "string" ? [lines] : lines
  const spans = rows.map((row, index) => '<tspan x="' + x + '" dy="' + (index === 0 ? 0 : lineHeight) + '">' + rich(row) + "</tspan>").join("")
  return '<text x="' + x + '" y="' + y + '" class="' + cls + '" text-anchor="' + anchor + '">' + spans + "</text>"
}

const rect = (x: number, y: number, w: number, h: number, cls: string, r = 10): string =>
  '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + r + '" class="' + cls + '"/>'

const circle = (cx: number, cy: number, r: number, cls: string): string => '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" class="' + cls + '"/>'

const path = (d: string, cls: string): string => '<path d="' + d + '" class="' + cls + '"/>'

const badge = (cx: number, cy: number, label: string, tone: "work" | "ask" = "work"): string =>
  circle(cx, cy, 12, "dot-" + tone) + text(cx, cy + 4.5, label, tone === "work" ? "num" : "num-ask", "middle")

const lineClass = (tone: Tone): string => (tone === "mute" ? "line" : "line-" + tone)

const arrow = (points: readonly (readonly [number, number])[], tone: Tone = "work"): string => {
  const last = points.at(-1) ?? [0, 0]
  const before = points.at(-2) ?? [0, 0]
  const angle = (Math.atan2(last[1] - before[1], last[0] - before[0]) * 180) / Math.PI
  const d = points.map(([x, y], index) => (index === 0 ? "M" : "L") + x + "," + y).join(" ")
  const head = '<path d="M0,0 L-9,-4.5 L-9,4.5 z" class="head-' + tone + '" transform="translate(' + last[0] + "," + last[1] + ") rotate(" + angle + ')"/>'
  return path(d, lineClass(tone)) + head
}

const tick = (cx: number, cy: number): string => circle(cx, cy, 9, "dot-ok") + '<path d="M' + (cx - 4) + "," + cy + ' l3,3.2 l5.2,-6" fill="none" stroke="var(--d-card)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'

const svg = (name: string, w: number, h: number, title: string, desc: string, body: readonly string[]): void => {
  const head = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + " " + h + '" class="orc-d" role="img" aria-labelledby="' + name + "-title " + name + '-desc">'
  const all = [head, '<title id="' + name + '-title">' + esc(title) + "</title>", '<desc id="' + name + '-desc">' + esc(desc) + "</desc>", "<style>" + style + "</style>", ...body, "</svg>", ""]
  writeFileSync(join(out, name + ".svg"), all.join("\n"))
}

const summary =
  "You describe the work. The backlog keeps it as one file per task. The beat picks what starts, on a machine with a free slot and an account with room. The runner queues it, an agent writes the change, the checks and a review judge it, and a pull request opens that you merge. A run's question waits in the attention queue, where a small model answers the routine ones from your rules and you answer the rest."

interface Stop {
  readonly title: readonly string[]
  readonly sub: readonly string[]
  readonly tall: readonly string[]
}

const stops: readonly Stop[] = [
  { title: ["You describe", "the work"], sub: ["in the chat, or", "as a task file"], tall: ["In the chat, or as a task file you add."] },
  { title: ["The backlog", "keeps it"], sub: ["one file per task,", "in priority order"], tall: ["One file per task, in priority order."] },
  { title: ["The beat picks", "what starts"], sub: ["every few minutes:", "a free machine, an", "account with room"], tall: ["Every few minutes: a task with a priority,", "a free machine and an account with room."] },
  { title: ["The runner", "queues it"], sub: ["a queue on that", "machine, a few", "tasks at a time"], tall: ["A queue on that machine, a few tasks at a time."] },
  { title: ["An agent writes", "the change"], sub: ["on its own copy", "of the project,", "on a new branch"], tall: ["On its own copy of the project, on a new branch."] },
  { title: ["Checks, then", "a review"], sub: ["the agent fixes", "what the checks", "refuse"], tall: ["The agent fixes what the checks refuse.", "Then a review reads the branch."] },
  { title: ["A pull request", "you merge"], sub: ["opened after the", "review, merged", "once CI is green"], tall: ["Opened after the review. You merge it", "once CI is green."] }
]

const zones = [
  { label: "You", from: 0, to: 0 },
  { label: "The machine that plans", from: 1, to: 2 },
  { label: "A machine that works", from: 3, to: 5 },
  { label: "GitHub", from: 6, to: 6 }
] as const

const routeWide = (): void => {
  const step = 134.5
  const cardW = 124
  const left = (index: number): number => 14 + step * index
  const mid = (index: number): number => left(index) + cardW / 2
  const body: string[] = []
  for (const zone of zones) {
    const x = left(zone.from) - 6
    body.push(rect(x, 8, left(zone.to) + cardW + 6 - x, 304, "zone", 14), text(x + 12, 29, zone.label, "label"))
  }
  body.push(arrow([[mid(0), 56], [mid(6) + 58, 56]], "work"))
  stops.forEach((stop, index) => {
    body.push(badge(mid(index), 56, String(index + 1)), rect(left(index), 80, cardW, 138, "card"), text(left(index) + 10, 104, stop.title, "title", "start", 18), text(left(index) + 10, 150, stop.sub))
  })
  body.push(rect(left(2), 250, cardW, 50, "card-work", 8), text(mid(2), 271, ["Quota: room left", "on each account"], "", "middle", 16), arrow([[mid(2), 250], [mid(2), 220]], "work"))
  body.push(text(14, 352, "When a run has a question it cannot settle", "ask-text"))
  body.push(arrow([[mid(4) - 12, 218], [mid(4) - 12, 370]], "ask"), arrow([[mid(4) + 12, 372], [mid(4) + 12, 220]], "ask"))
  body.push(text(mid(4) - 20, 346, "asks", "ask-text", "end"), text(mid(4) + 20, 346, "gets the answer", "ask-text"))
  body.push(rect(526, 372, 176, 108, "card-ask"), text(538, 398, "The attention queue", "title"), text(538, 422, ["every open question", "waits here"]))
  body.push(arrow([[526, 426], [492, 426]], "ask"))
  body.push(rect(290, 372, 200, 108, "card-ask"), text(302, 398, ["A small model answers", "the routine ones"], "title", "start", 18), text(302, 442, ["only by quoting a rule", "you wrote"]))
  body.push(arrow([[290, 426], [256, 426]], "ask"))
  body.push(rect(14, 372, 240, 108, "card-ask"), text(26, 398, "You answer the rest", "title"), text(26, 422, ["The chat tells you when a question", "waits and when a task ends."]))
  body.push(rect(746, 372, 200, 108, "card"), text(758, 398, ["The app and", "the dashboard"], "title", "start", 18), text(758, 442, ["They show all of this,", "and they only read."]))
  svg("how-orc-works-route", 960, 496, "How orc works: the route of one task", summary, body)
}

const routeTall = (): void => {
  const body: string[] = []
  const circles: string[] = []
  let y = 6
  let first = 0
  let last = 0
  stops.forEach((stop, index) => {
    const zone = zones.find((candidate) => candidate.from === index)
    if (zone !== undefined) {
      body.push(text(48, y + 16, zone.label, "label"))
      y += 26
    }
    if (index === 0) first = y + 18
    last = y + 18
    circles.push(badge(26, y + 18, String(index + 1)))
    body.push(text(48, y + 23, stop.title.join(" "), "title"), text(48, y + 43, stop.tall))
    y += 46 + stop.tall.length * 17
    if (index === 2) {
      body.push(rect(48, y - 4, 300, 34, "card-work", 8), text(60, y + 17, "Quota: room left on each account"))
      y += 42
    }
    y += 8
  })
  body.unshift(path("M26," + first + " V" + last, "line-work"))
  body.push(...circles)
  y += 10
  body.push(text(12, y + 12, "When a run has a question it cannot settle", "ask-text"))
  y += 26
  const asks = [
    { title: "The attention queue", sub: ["Every open question waits here."] },
    { title: "A small model answers the routine ones", sub: ["Only by quoting a rule you wrote."] },
    { title: "You answer the rest", sub: ["The chat tells you when a question waits", "and when a task ends."] }
  ]
  asks.forEach((ask, index) => {
    const h = 48 + ask.sub.length * 17
    body.push(rect(12, y, 336, h, "card-ask"), text(24, y + 25, ask.title, "title"), text(24, y + 46, ask.sub))
    y += h
    if (index < asks.length - 1) {
      body.push(arrow([[180, y + 2], [180, y + 22]], "ask"))
      y += 24
    }
  })
  y += 16
  body.push(rect(12, y, 336, 66, "card"), text(24, y + 25, "The app and the dashboard", "title"), text(24, y + 46, "They show all of this, and they only read."))
  y += 74
  svg("how-orc-works-route.tall", 360, y, "How orc works: the route of one task", summary, body)
}

const folders = (x: number, y: number): string[] => {
  const names = ["new", "taken", "closed"]
  return names.flatMap((name, index) => {
    const fx = x + index * 96
    const chip = [rect(fx, y, 72, 26, index === 0 ? "card-work" : "card", 6), text(fx + 36, y + 17.5, name, "code", "middle")]
    return index < names.length - 1 ? [...chip, arrow([[fx + 75, y + 13], [fx + 93, y + 13]], "mute")] : chip
  })
}

const clock = (cx: number, cy: number, r: number): string[] => [circle(cx, cy, r, "card"), path("M" + cx + "," + cy + " V" + (cy - r * 0.6) + " M" + cx + "," + cy + " H" + (cx + r * 0.45), "line")]

const bars = (x: number, y: number): string[] => [
  path("M" + x + "," + y + " h44", "faint"),
  path("M" + x + "," + y + " h34", "line-work"),
  path("M" + x + "," + (y + 10) + " h44", "faint"),
  path("M" + x + "," + (y + 10) + " h12", "line-work")
]

const slots = (x: number, y: number): string[] => [rect(x, y, 16, 16, "card-work", 4), rect(x + 21, y, 16, 16, "card-work", 4), rect(x + 42, y, 16, 16, "card", 4)]

const mapWide = (): void => {
  const body: string[] = []
  body.push(rect(8, 8, 188, 480, "zone", 14), text(22, 31, "You", "label"))
  body.push(rect(232, 8, 340, 480, "zone", 14), text(246, 31, "The machine that plans", "label"))
  body.push(rect(608, 8, 344, 318, "zone", 14), text(622, 31, "A machine that works", "label"))
  body.push(rect(608, 340, 344, 148, "zone", 14), text(622, 363, "GitHub", "label"))

  body.push(rect(20, 46, 164, 96, "card"), text(32, 71, "The chat", "title"), text(32, 93, ["Say the work.", "Answer questions."]))
  body.push(rect(20, 200, 164, 96, "card"), text(32, 225, ["The app and", "the dashboard"], "title", "start", 18), text(32, 266, "Watch. They only read."))
  body.push(rect(20, 378, 164, 96, "card"), text(32, 403, "`orc merge`", "title"), text(32, 425, ["Land a pull request", "once CI is green."]))

  body.push(rect(246, 46, 312, 96, "card"), text(258, 71, "The backlog", "title"), text(258, 91, "One file per task. The folder is its state."), ...folders(258, 104))
  body.push(rect(246, 190, 140, 112, "card-work"), ...bars(330, 210), text(258, 215, "Quota", "title"), text(258, 240, ["Room left on", "each account."]))
  body.push(rect(418, 190, 140, 112, "card"), ...clock(534, 212, 12), text(430, 215, "The beat", "title"), text(430, 240, ["Every few minutes,", "starts what can", "start."]))
  body.push(rect(246, 350, 312, 112, "card-ask"), text(258, 375, "The attention queue", "title"), text(258, 397, ["Every open question waits here. A small model", "answers the routine ones from your rules.", "The rest wait for you."]))

  body.push(rect(622, 46, 316, 74, "card"), ...slots(868, 60), text(634, 71, "The runner", "title"), text(634, 93, "A queue on the machine, a few tasks at a time."))
  body.push(rect(622, 150, 316, 162, "card"), text(634, 175, "A run", "title"), text(634, 195, "Its own copy of the project, on a new branch."))
  body.push(rect(634, 214, 88, 40, "card-work", 8), text(678, 239, "Agent writes", "", "middle"), arrow([[724, 234], [740, 234]], "work"))
  body.push(rect(742, 214, 78, 40, "card-work", 8), text(781, 239, "Checks", "", "middle"), arrow([[822, 234], [838, 234]], "work"))
  body.push(rect(840, 214, 86, 40, "card-work", 8), text(883, 239, "Review", "", "middle"))
  body.push(arrow([[781, 256], [781, 276], [678, 276], [678, 258]], "ask"), text(730, 296, "refused: the agent fixes it", "ask-text", "middle"))

  body.push(rect(622, 378, 316, 96, "card-ok"), tick(916, 400), text(634, 403, "The pull request", "title"), text(634, 425, ["Opened after the review.", "Merged once CI is green."]))

  body.push(arrow([[184, 76], [244, 76]], "work"), badge(214, 76, "1"))
  body.push(arrow([[488, 142], [488, 188]], "work"), badge(488, 164, "2"))
  body.push(arrow([[386, 246], [416, 246]], "work"))
  body.push(arrow([[558, 226], [590, 226], [590, 83], [620, 83]], "work"), badge(590, 150, "3"))
  body.push(arrow([[780, 120], [780, 148]], "work"), badge(780, 134, "4"))
  body.push(arrow([[883, 256], [883, 376]], "work"), badge(883, 326, "5"))
  body.push(arrow([[184, 440], [214, 440], [214, 475], [590, 475], [590, 440], [620, 440]], "work"), badge(400, 475, "6"))
  body.push(arrow([[622, 290], [590, 290], [590, 400], [560, 400]], "ask"), badge(590, 345, "?", "ask"))
  body.push(arrow([[246, 400], [214, 400], [214, 120], [186, 120]], "ask"), badge(214, 300, "?", "ask"))
  svg("how-orc-works-map", 960, 496, "How orc works: where each part lives", summary, body)
}

const mapTall = (): void => {
  const body: string[] = []
  let y = 4
  const zone = (label: string, h: number): number => {
    body.push(rect(4, y, 352, h, "zone", 14), text(18, y + 23, label, "label"))
    const top = y
    y += h + 30
    return top
  }
  const down = (from: number, label: string, tone: "work" | "ask" = "work"): void => {
    body.push(arrow([[180, from], [180, from + 28]], tone), badge(180, from + 12, label, tone))
  }
  const you = zone("You", 116)
  body.push(rect(16, you + 34, 328, 70, "card"), text(28, you + 59, "The chat", "title"), text(28, you + 80, "Say the work. Answer questions."))
  down(you + 117, "1")
  const plan = zone("The machine that plans", 442)
  body.push(rect(16, plan + 34, 328, 100, "card"), text(28, plan + 59, "The backlog", "title"), text(28, plan + 79, "One file per task. The folder is its state."), ...folders(28, plan + 94))
  body.push(arrow([[180, plan + 135], [180, plan + 163]], "work"), badge(180, plan + 148, "2"))
  body.push(rect(16, plan + 166, 328, 70, "card"), ...clock(322, plan + 190, 12), text(28, plan + 191, "The beat", "title"), text(28, plan + 212, "Every few minutes, starts what can start."))
  body.push(rect(16, plan + 246, 328, 70, "card-work"), ...bars(284, plan + 266), text(28, plan + 271, "Quota", "title"), text(28, plan + 292, "Room left on each account. The beat reads it."))
  body.push(rect(16, plan + 326, 328, 104, "card-ask"), text(28, plan + 351, "The attention queue", "title"), text(28, plan + 372, ["Every open question waits here. A small model", "answers the routine ones from your rules.", "The rest wait for you."]))
  down(plan + 443, "3")
  const work = zone("A machine that works", 294)
  body.push(rect(16, work + 34, 328, 70, "card"), ...slots(274, work + 46), text(28, work + 59, "The runner", "title"), text(28, work + 80, "A queue on the machine, a few tasks at a time."))
  body.push(arrow([[180, work + 105], [180, work + 131]], "work"), badge(180, work + 117, "4"))
  body.push(rect(16, work + 134, 328, 148, "card"), text(28, work + 159, "A run", "title"), text(28, work + 179, "Its own copy of the project, on a new branch."))
  body.push(rect(28, work + 194, 96, 38, "card-work", 8), text(76, work + 218, "Agent writes", "", "middle"), arrow([[126, work + 213], [140, work + 213]], "work"))
  body.push(rect(142, work + 194, 84, 38, "card-work", 8), text(184, work + 218, "Checks", "", "middle"), arrow([[228, work + 213], [242, work + 213]], "work"))
  body.push(rect(244, work + 194, 88, 38, "card-work", 8), text(288, work + 218, "Review", "", "middle"))
  body.push(text(28, work + 258, "Refused: the agent fixes it. A question it", "ask-text"), text(28, work + 274, "cannot settle goes to the attention queue.", "ask-text"))
  down(work + 295, "5")
  const hub = zone("GitHub", 122)
  body.push(rect(16, hub + 34, 328, 76, "card-ok"), tick(322, hub + 56), text(28, hub + 59, "The pull request", "title"), text(28, hub + 80, ["Opened after the review. You merge it with", "`orc merge` once CI is green."], "", "start", 16))
  svg("how-orc-works-map.tall", 360, y - 26, "How orc works: where each part lives", summary, body)
}

interface Panel {
  readonly title: string
  readonly wide: readonly string[]
  readonly draw: (x: number, y: number) => string[]
}

const stroke = (x: number, y: number, w: number): string => path("M" + x + "," + y + " h" + w, "faint")

const panels: readonly Panel[] = [
  {
    title: "You say what you want",
    wide: ["Tell the chat, or add a task file.", "Each task is one file in the backlog."],
    draw: (x, y) => [
      rect(x + 24, y + 20, 112, 56, "card", 14),
      path("M" + (x + 48) + "," + (y + 76) + " l-8,16 l24,-16", "card"),
      stroke(x + 40, y + 38, 80),
      stroke(x + 40, y + 50, 80),
      stroke(x + 40, y + 62, 48),
      arrow([[x + 148, y + 48], [x + 180, y + 48]], "work"),
      rect(x + 190, y + 12, 70, 88, "card-work", 6),
      text(x + 200, y + 34, "orc-9", "code"),
      stroke(x + 200, y + 50, 50),
      stroke(x + 200, y + 62, 50),
      stroke(x + 200, y + 74, 30)
    ]
  },
  {
    title: "The beat picks what can start",
    wide: ["Every few minutes it looks for a free", "machine and an account with room."],
    draw: (x, y) => [
      ...clock(x + 54, y + 56, 30),
      rect(x + 112, y + 10, 150, 26, "card-work", 6),
      text(x + 122, y + 27.5, "orc-9"), text(x + 252, y + 27.5, "starts", "work-text", "end"),
      rect(x + 112, y + 43, 150, 26, "card", 6),
      text(x + 122, y + 60.5, "orc-10"), text(x + 252, y + 60.5, "waits", "", "end"),
      rect(x + 112, y + 76, 150, 26, "card", 6),
      text(x + 122, y + 93.5, "orc-11"), text(x + 252, y + 93.5, "waits", "", "end")
    ]
  },
  {
    title: "An agent writes the change",
    wide: ["On that machine, in its own copy of", "the project, on a new branch."],
    draw: (x, y) => [
      rect(x + 20, y + 12, 156, 88, "card", 8),
      circle(x + 32, y + 24, 3, "dot-mute"), circle(x + 42, y + 24, 3, "dot-mute"), circle(x + 52, y + 24, 3, "dot-mute"),
      path("M" + (x + 32) + "," + (y + 44) + " l6,5 l-6,5", "line-work"), stroke(x + 46, y + 49, 70),
      stroke(x + 32, y + 66, 110), stroke(x + 32, y + 80, 84),
      path("M" + (x + 208) + "," + (y + 16) + " V" + (y + 96), "line"),
      circle(x + 208, y + 20, 5, "dot-mute"), circle(x + 208, y + 88, 5, "dot-mute"),
      path("M" + (x + 208) + "," + (y + 88) + " C" + (x + 208) + "," + (y + 60) + " " + (x + 244) + "," + (y + 76) + " " + (x + 244) + "," + (y + 50) + " V" + (y + 26), "line-work"),
      circle(x + 244, y + 50, 5, "dot-work"), circle(x + 244, y + 26, 5, "dot-work")
    ]
  },
  {
    title: "Checks and a review judge it",
    wide: ["The agent fixes what the checks refuse.", "Then a review reads the branch."],
    draw: (x, y) => [
      rect(x + 20, y + 22, 106, 40, "card", 8), text(x + 34, y + 47, "Checks", "title"), tick(x + 108, y + 42),
      arrow([[x + 130, y + 42], [x + 152, y + 42]], "work"),
      rect(x + 156, y + 22, 106, 40, "card", 8), text(x + 170, y + 47, "Review", "title"), tick(x + 244, y + 42),
      arrow([[x + 100, y + 64], [x + 100, y + 86], [x + 46, y + 86], [x + 46, y + 66]], "ask"),
      text(x + 112, y + 90, "refused: fix and run again", "ask-text")
    ]
  },
  {
    title: "You merge the pull request",
    wide: ["It opens after the review. `orc merge`", "lands it once CI is green."],
    draw: (x, y) => [
      rect(x + 20, y + 16, 132, 80, "card", 8), text(x + 32, y + 40, "Pull request", "title"), stroke(x + 32, y + 56, 96),
      tick(x + 42, y + 76), text(x + 58, y + 80.5, "CI green", "ok-text"),
      arrow([[x + 158, y + 56], [x + 186, y + 56]], "work"),
      rect(x + 190, y + 38, 72, 36, "card-ok", 18), text(x + 226, y + 60.5, "merged", "ok-text", "middle")
    ]
  },
  {
    title: "A question stops only that task",
    wide: ["A small model answers routine ones from", "your rules. The rest come to you in the chat."],
    draw: (x, y) => [
      rect(x + 16, y + 38, 70, 36, "card-ask", 8), text(x + 51, y + 61, "orc-9  ?", "ask-text", "middle"),
      arrow([[x + 90, y + 50], [x + 112, y + 50], [x + 112, y + 28], [x + 134, y + 28]], "ask"),
      arrow([[x + 90, y + 62], [x + 112, y + 62], [x + 112, y + 84], [x + 134, y + 84]], "ask"),
      rect(x + 138, y + 10, 128, 36, "card", 8), text(x + 202, y + 33, "a small model", "", "middle"),
      rect(x + 138, y + 66, 128, 36, "card", 8), text(x + 202, y + 89, "you", "", "middle")
    ]
  }
]

const story = (name: string, columns: number, panelW: number, gap: number, margin: number): void => {
  const panelH = 218
  const stageW = 280
  const body: string[] = []
  panels.forEach((panel, index) => {
    const x = margin + (index % columns) * (panelW + gap)
    const y = margin + Math.floor(index / columns) * (panelH + gap)
    const stage = x + (panelW - stageW) / 2
    body.push(rect(x, y, panelW, panelH, "card", 14), rect(stage, y + 12, stageW, 112, "zone", 10), ...panel.draw(stage, y + 12))
    body.push(badge(x + 26, y + 150, String(index + 1)), text(x + 46, y + 155, panel.title, "big"), text(x + 14, y + 183, panel.wide))
  })
  const rows = Math.ceil(panels.length / columns)
  svg(name, margin * 2 + columns * panelW + (columns - 1) * gap, margin * 2 + rows * panelH + (rows - 1) * gap, "How orc works: one task in six scenes", summary, body)
}

mkdirSync(out, { recursive: true })
routeWide()
routeTall()
mapWide()
mapTall()
story("how-orc-works-story", 3, 304, 12, 8)
story("how-orc-works-story.tall", 1, 344, 12, 8)
