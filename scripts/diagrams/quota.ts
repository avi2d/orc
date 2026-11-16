import { arrow, bullets, card, svg, tall, text, zone, type Drawing, type Part } from "./kit"

const title = "Accounts and quota: which account a run spends"

const desc =
  "You name the accounts and the quota command once in dispatch.json. Each beat runs the command before it takes a task. When the command fails or prints something else, the beat starts nothing. Otherwise the accounts above 0% and at or above the floor can run, and the beat takes the one with the most room. The account's kind decides how its credential reaches the run."

const config: Part = { title: "`dispatch.json`", text: "Its `quota` part names the accounts, the floor and the command that reads their room." }
const command: Part = { title: "The quota command", text: "Prints one JSON document: for each account, the percent of room left, or why it cannot run." }
const read: Part = { title: "Did the beat read it?", text: "Not when the command fails, runs past 15 seconds or prints anything else." }
const nothing: Part = { title: "This beat starts nothing" }
const usable: Part = {
  title: "Which accounts can run?",
  ...bullets(["named in the document", "room above 0%", "at or above `floorPercent`, when you set one"])
}
const most: Part = { title: "The one with the most room", text: "Every task this beat starts takes it.", cls: "card-work" }

const kinds: readonly Part[] = [
  { title: "`token-file`", text: "The path of a token file on the machine, never the token." },
  { title: "`token-command`", text: "A token the command prints, sent on standard input and renewed each beat." },
  { title: "`claude-config`", text: "The path of that account's Claude config directory." },
  { title: "`none`", text: "Nothing. The provider's own package logs in." }
]

const wide = (): Drawing => {
  const body = [
    zone(8, 8, 170, 480, "You, once"),
    zone(198, 8, 474, 480, "Every beat, before it takes a task"),
    zone(692, 8, 260, 480, "What the run is handed, by kind"),
    card(18, 42, 150, 130, config),
    card(210, 42, 216, 110, command),
    card(210, 196, 216, 110, read),
    card(210, 370, 216, 60, nothing),
    card(446, 42, 216, 130, usable),
    card(446, 236, 216, 96, most),
    ...kinds.map((kind, index) => card(702, 42 + index * 110, 240, 100, kind)),
    arrow([[168, 90], [208, 90]], "work"),
    arrow([[318, 152], [318, 194]], "work"),
    arrow([[318, 306], [318, 368]], "ask"),
    text(328, 342, "no", "ask-text"),
    arrow([[426, 250], [436, 250], [436, 100], [444, 100]], "work"),
    text(442, 210, "yes"),
    arrow([[554, 172], [554, 234]], "work"),
    arrow([[662, 280], [700, 280]], "work")
  ]
  return svg("quota", 960, 496, title, desc, body)
}

export const quota = (): readonly Drawing[] => [
  wide(),
  tall("quota", title, desc, [
    { label: "You, once", rows: [config] },
    { label: "Every beat, before it takes a task", rows: [command, { arrow: "work" }, read, { note: "No: this beat starts nothing." }, { arrow: "work", note: "yes" }, usable, { arrow: "work" }, most] },
    { label: "What the run is handed, by kind", rows: kinds }
  ])
]
