import { arrow, bullets, card, svg, tall, zone, type Part } from "./kit"

const title = "A run: one attempt at one task"

const desc =
  "The runner starts most runs, and you can start one by hand. A run makes a copy of the project on a new branch, runs the prepare command, and starts the Pi agent, which writes the change and commits it. The project's checks run, a fixer repairs what failed up to three times, and the run delivers a pull request or a report. Orc watches Pi while it works, and keeps the record of every run in its own folder."

const byRunner: Part = { title: "The runner", text: "The beat starts most runs through it, on the host.", href: "runner" }
const byHand: Part = { title: "You, by hand", text: "`orc run <task-file>` in a clean checkout. It works inside the nono sandbox unless you say otherwise." }

const steps: readonly Part[] = [
  { step: "1", title: "A copy", text: "A git worktree on a new branch, under `~/.orc/worktrees`. Your own checkout is never touched." },
  { step: "2", title: "Prepare", text: "The project's `prepare` command, such as an install." },
  { step: "3", title: "Pi works", text: "The agent writes the change, commits it, and prints `ORC_COMPLETE`." },
  { step: "4", title: "Checks", text: "The project's own checks. A fixer repairs what failed, up to three times.", href: "checks" },
  { step: "5", title: "Deliver", text: "Review, push, pull request. A report run writes `agent-report.md` instead.", href: "checks" }
]

const watch: Part = {
  title: "What orc does about it",
  cls: "card-ask",
  href: "attention",
  ...bullets([
    "Pi prints nothing for 45 minutes with no tool running: orc stops it.",
    "Pi fails one command 3 times in a row: you are told.",
    "Pi fails it 6 times in a row: orc stops Pi and asks you whether to continue.",
    "Pi is unsure: it asks you a question instead of guessing."
  ])
}
const record: Part = { title: "`~/.orc/runs/<run-id>`", text: "The task, the logs, the Pi session and `report.md`. Read it with `orc runs`, `orc show` and `orc log`." }
const resume: Part = { title: "Resume", text: "`orc run --branch <name>` skips the steps that passed, and Pi resumes its session." }

const wide = (): void => {
  const body = [
    zone(8, 8, 170, 482, "Who starts it"),
    zone(198, 8, 754, 230, "The run, on a machine that works"),
    zone(198, 252, 440, 238, "Orc watches Pi while it works"),
    zone(658, 252, 294, 238, "The record"),
    card(18, 42, 150, 120, byRunner),
    card(18, 176, 150, 170, byHand),
    ...steps.map((step, index) => card(208 + index * 150, 42, 134, 186, step)),
    ...steps.slice(1).map((_, index) => arrow([[342 + index * 150, 100], [356 + index * 150, 100]], "work")),
    card(208, 286, 420, 194, watch),
    card(668, 286, 274, 96, record),
    card(668, 388, 274, 94, resume),
    arrow([[168, 90], [206, 90]], "work"),
    arrow([[575, 228], [575, 284]], "ask"),
    arrow([[875, 228], [875, 284]], "mute")
  ]
  svg("run", 960, 498, title, desc, body)
}

export const run = (): void => {
  wide()
  tall("run", title, desc, [
    { label: "Who starts it", rows: [byRunner, byHand] },
    { label: "The run, on a machine that works", rows: steps.flatMap((step, index) => (index === 0 ? [step] : [{ arrow: "work" as const }, step])) },
    { label: "Orc watches Pi while it works", rows: [watch] },
    { label: "The record", rows: [record, resume] }
  ])
}
