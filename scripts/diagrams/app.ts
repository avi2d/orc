import { arrow, card, svg, tall, zone, type Drawing, type Part } from "./kit"

const title = "The app and the dashboard: two screens over the same commands"

const desc =
  "The Herdr App layout and the orc-dash terminal dashboard hold no state of their own. Both run the orc commands and draw what those print. The app has a Board tab, an Agents tab, a Resources tab and a chat drawer. The dashboard shows the same facts as panels in a terminal, and its alert stream is where the chat's alerts come from."

const state: Part = { title: "The state", text: "Files in `~/.orc`, and the pueue queues." }
const commands: Part = { title: "The `orc` commands", text: "`orc backlog`, `orc runs` and `orc attention`, printed as JSON." }
const snapshot: Part = { title: "`orc-dash snapshot`", text: "What the Resources tab draws." }

const board: Part = { title: "Board", text: "The backlog as cards in five lanes: Backlog, Planned, Awaiting you, Running and Done. A card opens the task, with its open questions to answer.", href: "backlog" }
const agents: Part = { title: "Agents", text: "The runs and the queued tasks. Each step, the agent's turns and the changes. The Approve step merges through `orc merge`.", href: "run" }
const resources: Part = { title: "Resources", text: "Each account's quota windows. Each machine's cores, load, memory, disk and running runs.", href: "quota" }
const drawer: Part = { title: "The chat drawer", text: "`cmd-k` on any tab. The same `orc chat` as in a terminal, with the same fourteen tools.", href: "chat" }
const same: Part = { title: "Neither screen holds state of its own", text: "Both run the `orc` commands and draw what those print, so a screen and the command line never disagree." }

const dash: Part = { title: "`orc-dash`", text: "The same facts as panels: quota, session quota, resources, queues, schedules, dispatch, attention, tasks, alerts and ledger." }
const alerts: Part = { title: "Its alert stream", text: "It watches quota pace, machine load and long tasks. The chat's alerts come from here.", href: "chat" }

const wide = (): Drawing => {
  const body = [
    zone(8, 8, 200, 480, "What both screens draw"),
    zone(228, 8, 484, 480, "The Herdr App"),
    zone(732, 8, 220, 480, "The terminal"),
    card(18, 42, 180, 100, state),
    card(38, 176, 160, 120, commands),
    card(18, 330, 180, 100, snapshot),
    arrow([[118, 142], [118, 174]], "work"),
    arrow([[28, 142], [28, 328]], "work"),
    card(238, 42, 227, 158, board),
    card(475, 42, 227, 158, agents),
    card(238, 212, 227, 158, resources),
    card(475, 212, 227, 158, drawer),
    card(238, 388, 464, 90, same),
    arrow([[198, 186], [236, 186]], "work"),
    arrow([[198, 350], [236, 350]], "work"),
    card(742, 42, 200, 158, dash),
    card(742, 212, 200, 158, alerts)
  ]
  return svg("app", 960, 496, title, desc, body)
}

export const app = (): readonly Drawing[] => [
  wide(),
  tall("app", title, desc, [
    { label: "What both screens draw", rows: [state, { arrow: "work" }, commands, snapshot, same] },
    { label: "The Herdr App", rows: [board, agents, resources, drawer] },
    { label: "The terminal", rows: [dash, alerts] }
  ])
]
