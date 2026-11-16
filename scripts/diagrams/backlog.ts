import { arrow, bullets, card, svg, tall, text, zone, type Drawing, type Part } from "./kit"

const title = "The backlog: where a task file sits, and how it moves"

const desc =
  "You add a task in the chat or with orc backlog add. Its file sits in the folder new until a beat takes it, then in taken while its run is queued or running, then in closed with its outcome. A run that stops on a question sends the task back to new, and so does orc backlog send-back. The kind of a task, ship, scout, task, parent or decision, decides how it ends."

const add: Part = { title: "Add a task", text: "Say it in the chat, or run `orc backlog add`.", href: "chat" }
const drop: Part = { title: "Change your mind", text: "`orc backlog drop` closes a task that has not started." }

const fresh: Part = {
  title: "`new`",
  text: "Waiting to start, in priority order. It waits while:",
  cls: "card-work",
  ...bullets(["it has no priority", "you hold it", "a question has no answer", "it depends on an open task", "no machine has a free slot", "no account has room"])
}
const taken: Part = { title: "`taken`", text: "A beat took it. Its run is queued or running on a machine.", href: "beat" }
const closed: Part = {
  title: "`closed`",
  text: "It keeps its outcome and the reason:",
  ...bullets(["`done`, with a pull request or a report", "`failed` or `start-failed`", "`stopped`", "`dropped`"])
}

const kinds: readonly Part[] = [
  { title: "`ship`", text: "The default. Changes code and ends in a pull request." },
  { title: "`scout`", text: "Reads the project and changes nothing. Ends in a report." },
  { title: "`task`", text: "Does the work it describes. Ends in a report with its evidence." },
  { title: "`parent`", text: "Holds work too large for one pull request. Ends once its children are done." },
  { title: "`decision`", text: "Asks you a question and never runs. Ends with your answer." }
]

const wide = (): Drawing => {
  const body = [
    zone(8, 8, 170, 300, "You"),
    zone(198, 8, 754, 300, "The folder a task file sits in is its state"),
    zone(8, 322, 944, 166, "The kind of a task decides how it ends"),
    card(18, 42, 150, 120, add),
    card(18, 176, 150, 120, drop),
    card(210, 42, 200, 254, fresh),
    card(480, 42, 200, 104, taken),
    card(740, 42, 200, 254, closed),
    arrow([[168, 90], [208, 90]], "work"),
    arrow([[410, 84], [478, 84]], "work"),
    text(444, 62, ["a beat", "takes it"], "", "middle", 14),
    arrow([[680, 84], [738, 84]], "work"),
    text(710, 62, ["the run", "ends"], "", "middle", 14),
    arrow([[480, 126], [412, 126]], "ask"),
    text(446, 146, ["its run", "stops on a", "question"], "ask-text", "middle", 14),
    arrow([[738, 250], [412, 250]], "ask"),
    text(575, 242, "`orc backlog send-back`: one more pass", "ask-text", "middle"),
    ...kinds.map((kind, index) => card(18 + index * 186.5, 356, 176, 122, kind))
  ]
  return svg("backlog", 960, 496, title, desc, body)
}

export const backlog = (): readonly Drawing[] => [
  wide(),
  tall("backlog", title, desc, [
    { label: "You", rows: [add, drop] },
    {
      label: "The folder a task file sits in is its state",
      rows: [fresh, { arrow: "work", note: "a beat takes it" }, taken, { arrow: "work", note: "the run ends" }, closed, { note: "A run that stops on a question sends its task back to `new`. So does `orc backlog send-back`, for one more pass on a pull request." }]
    },
    { label: "The kind of a task decides how it ends", rows: kinds }
  ])
]
