import { arrow, card, svg, tall, text, zone, type Drawing, type Part } from "./kit"

const title = "The beat: what lets a task start"

const desc =
  "A beat is one pass of orc beat, which cron or launchd runs every few minutes. It takes the new tasks in priority order. A task starts once it has a priority, nothing open waits on it, everything it depends on is done, a machine with its checkout has a free slot, and an account has room. Otherwise it waits for the next beat. Every beat also closes finished runs, parks and resumes tasks, passes questions and answers, and watches runs and pull requests."

const conditions: readonly Part[] = [
  { title: "A priority", text: "Priority 0 goes first, then the oldest task." },
  { title: "Nothing open", text: "No hold, and no question without an answer." },
  { title: "Nothing ahead", text: "Each task it depends on closed done. A ship task also waits for their pull requests to merge." },
  { title: "A free slot", text: "On a machine that holds the project's checkout.", href: "runner" },
  { title: "Room", text: "An account above 0% and at or above the floor.", href: "quota" }
]

const starts: Part = { title: "It starts", text: "The beat takes the task and runs the machine's start command.", cls: "card-ok", href: "runner" }
const waits: Part = { title: "It waits for the next beat", text: "The beat prints `waits <task-id>:` with the reason. A decision never starts." }

const also: readonly Part[] = [
  { title: "Runs on a clock", text: "Cron or launchd runs `orc beat` every few minutes. Orc has no daemon." },
  { title: "Closes runs", text: "Done, failed or stopped, as `orc runner result` says.", href: "backlog" },
  { title: "Parks and resumes", text: "Parks a task whose run stopped on a question. Resumes it once you answer." },
  { title: "Carries questions", text: "Opens attention items, gives the decider its questions, hands answers to a waiting run.", href: "attention" },
  { title: "Watches", text: "Flags a run silent for 30 minutes. Records when a pull request turns green or merges." }
]

const wide = (): Drawing => {
  const body = [
    zone(8, 8, 944, 292, "A new task starts once all five hold, in priority order"),
    zone(8, 314, 944, 174, "Every beat also does this"),
    ...conditions.map((condition, index) => card(18 + index * 156, 42, 140, 142, condition)),
    ...conditions.slice(1).map((_, index) => arrow([[158 + index * 156, 96], [172 + index * 156, 96]], "work")),
    arrow([[782, 96], [798, 96]], "work"),
    card(800, 42, 142, 142, starts),
    card(18, 228, 764, 66, waits),
    ...conditions.flatMap((_, index) => [arrow([[88 + index * 156, 184], [88 + index * 156, 226]], "ask"), text(96 + index * 156, 210, "no", "ask-text")]),
    ...also.map((item, index) => card(18 + index * 186.5, 348, 176, 130, item))
  ]
  return svg("beat", 960, 496, title, desc, body)
}

export const beat = (): readonly Drawing[] => [
  wide(),
  tall("beat", title, desc, [
    { label: "A new task starts once all five hold", rows: [...conditions, { arrow: "work", note: "all five hold" }, starts, { note: "If one does not hold:" }, waits] },
    { label: "Every beat also does this", rows: also }
  ])
]
