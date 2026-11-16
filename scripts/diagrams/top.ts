import { arrow, bullets, card, chip, path, svg, tall, text, zone, type Drawing, type Part } from "./kit"

const title = "How orc works: every part, and every way a task ends"

const desc =
  "You say the work in the chat. The backlog keeps one file per task. The beat reads the quota and starts a task on a machine with a free slot. The runner queues it, an agent writes the change, and the checks and a review judge it. A question waits in the attention queue, where the decider answers the routine ones and you answer the rest. A task ends dropped, answered, stopped, failed, with a report, or with a pull request that you merge."

const folders = (x: number, y: number): string[] => [
  chip(x, y, 68, "`new`", "card-work"),
  arrow([[x + 71, y + 13], [x + 95, y + 13]], "mute"),
  chip(x + 98, y, 68, "`taken`"),
  arrow([[x + 169, y + 13], [x + 193, y + 13]], "mute"),
  chip(x + 196, y, 68, "`closed`")
]

const gates = (x: number, y: number): string[] => [chip(x, y, 82, "Checks", "card-work", 32), arrow([[x + 85, y + 16], [x + 95, y + 16]], "work"), chip(x + 98, y, 82, "Review", "card-work", 32)]

const bars = (x: number, y: number): string[] => [
  path("M" + x + "," + (y + 8) + " h110", "faint"),
  path("M" + x + "," + (y + 8) + " h82", "line-work"),
  path("M" + x + "," + (y + 20) + " h110", "faint"),
  path("M" + x + "," + (y + 20) + " h30", "line-work")
]

const limits = bullets(["Still red after three fixes: the run fails.", "A question waits here 30 minutes. Then the task parks on its branch."])

const chat: Part = { step: "1", title: "The chat", text: "Say the work. Answer questions.", href: "chat" }
const app: Part = { title: "The app and the dashboard", text: "Show it all. Hold no state.", href: "app" }
const merge: Part = { title: "`orc merge`", text: "Land a pull request once CI is green.", href: "merge" }
const backlog: Part = { step: "2", title: "The backlog", text: "One file per task, in priority order.", href: "backlog", extra: (x, y) => folders(x, y), extraHeight: () => 34 }
const quota: Part = { title: "Quota", text: "Room left on each account.", cls: "card-work", href: "quota", extra: (x, y) => bars(x, y), extraHeight: () => 30 }
const beat: Part = { step: "3", title: "The beat", text: "Every few minutes, starts what can start.", href: "beat" }
const decider: Part = { title: "The decider", text: "A small model. It answers a routine question by quoting a rule you wrote.", cls: "card-ask", href: "attention" }
const attention: Part = { title: "The attention queue", text: "Every open question waits here.", cls: "card-ask", href: "attention" }
const runner: Part = { step: "4", title: "The runner", text: "A queue on the machine, a few tasks at a time.", href: "runner" }
const run: Part = { step: "5", title: "A run", text: "An agent writes the change in its own copy of the project, on a new branch.", href: "run" }
const checks: Part = {
  step: "6",
  title: "Checks and review",
  text: "The agent fixes what the checks refuse. Then a review reads the branch.",
  href: "checks",
  extra: (x, y, w) => [...gates(x, y + 6), ...(limits.extra?.(x, y + 46, w) ?? [])],
  extraHeight: (w) => 46 + (limits.extraHeight?.(w) ?? 0)
}

const dropped: Part = { title: "Dropped", text: "Before it started." }
const answered: Part = { title: "Answered", text: "A decision never runs. Your answer closes it." }
const stopped: Part = { title: "Stopped", text: "You stopped the run." }
const failed: Part = { title: "Failed", text: "It could not start, it died, or its checks stayed red." }
const report: Part = { title: "A report", text: "A task that changes no code. No pull request.", cls: "card-ok" }
const pullRequest: Part = { title: "A pull request", text: "A code change. You merge it once CI is green.", cls: "card-ok", href: "merge" }

const wide = (): Drawing => {
  const body = [
    zone(8, 8, 150, 576, "You"),
    zone(178, 8, 308, 576, "The machine that plans"),
    zone(506, 8, 224, 576, "A machine that works"),
    zone(754, 8, 198, 576, "How a task ends"),
    card(18, 42, 130, 104, chat),
    card(18, 220, 130, 118, app),
    card(18, 466, 130, 108, merge),
    card(188, 42, 288, 104, backlog),
    card(188, 170, 134, 124, quota),
    card(342, 170, 134, 124, beat),
    card(188, 404, 134, 170, decider),
    card(342, 404, 134, 170, attention),
    card(516, 42, 204, 96, runner),
    card(516, 162, 204, 120, run),
    card(516, 306, 204, 268, checks),
    text(766, 50, "Without a run", "label"),
    card(764, 58, 178, 62, dropped),
    card(764, 126, 178, 78, answered),
    text(766, 224, "After a run", "label"),
    card(764, 232, 178, 62, stopped),
    card(764, 300, 178, 94, failed),
    card(764, 400, 178, 78, report),
    card(764, 484, 178, 78, pullRequest),
    arrow([[148, 80], [186, 80]], "work"),
    arrow([[409, 146], [409, 168]], "work"),
    arrow([[322, 232], [340, 232]], "work"),
    arrow([[476, 232], [496, 232], [496, 90], [514, 90]], "work"),
    arrow([[618, 138], [618, 160]], "work"),
    arrow([[618, 282], [618, 304]], "work"),
    arrow([[514, 489], [478, 489]], "ask", true),
    arrow([[340, 489], [324, 489]], "ask", true),
    arrow([[409, 402], [409, 350], [168, 350], [168, 120], [150, 120]], "ask", true),
    text(182, 343, "the rest wait for you", "ask-text"),
    path("M720,432 H742 M742,263 V514", "line-work"),
    arrow([[742, 263], [762, 263]], "work"),
    arrow([[742, 347], [762, 347]], "work"),
    arrow([[742, 439], [762, 439]], "work"),
    arrow([[742, 514], [762, 514]], "work"),
    arrow([[148, 556], [168, 556], [168, 579], [742, 579], [742, 544], [762, 544]], "work")
  ]
  return svg("how-orc-works", 960, 592, title, desc, body)
}

export const top = (): readonly Drawing[] => [
  wide(),
  tall("how-orc-works", title, desc, [
    { label: "You", rows: [chat, app, merge] },
    { label: "The machine that plans", rows: [backlog, { arrow: "work" }, beat, quota, attention, { arrow: "ask", note: "routine questions" }, decider, { note: "The rest wait for you." }] },
    { label: "A machine that works", rows: [runner, { arrow: "work" }, run, { arrow: "work" }, checks, { note: "A question the run cannot settle goes to the attention queue." }] },
    { label: "How a task ends", rows: [dropped, answered, stopped, failed, report, pullRequest] }
  ])
]
