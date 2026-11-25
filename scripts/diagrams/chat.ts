import { arrow, bullets, card, svg, tall, zone, type Drawing, type Part } from "./kit"

const title = "The chat: your words in, backlog commands out"

const desc =
  "You say the work, an answer or a merge in orc chat. The chat is a Pi session with eighteen tools, each one an orc command, so it can change the backlog and nothing else. It starts nothing itself: the beat starts the tasks. Every 15 seconds it reads the backlog and posts what changed: closed tasks, questions that wait on you, pull request events and alerts. Your rules file steers both the chat and the decider."

const say: Part = { title: "You say", ...bullets(["the work, in plain words", "an answer to a question", "to merge a pull request"]) }
const read: Part = { title: "You read", text: "Each change, posted as it happens." }
const model: Part = { title: "The orchestrator model", text: "A Pi session with eighteen tools and no others. It can change the backlog and nothing else." }
const rules: Part = { title: "Your rules", text: "`~/.orc/orchestrator.md`, and each project's instructions file. The decider reads the same files.", href: "attention" }
const posts: Part = {
  title: "It posts what changed",
  text: "It reads `orc backlog --json` every 15 seconds.",
  ...bullets([
    "each task that closed, with its outcome and its pull request or report",
    "each held task and each parked question that waits on you",
    "a stalled run, and a pull request that turned green, merged or closed",
    "each alert from the dashboard"
  ])
}
const shape: Part = {
  title: "Shape the backlog",
  ...bullets(["`orc_backlog_add`: adds a task", "`orc_backlog_edit`: replaces its title and body", "`orc_backlog_priority`: sets its priority", "`orc_backlog_hold`: holds it for your decision"])
}
const answer: Part = {
  title: "Read and answer",
  ...bullets([
    "`orc_backlog`: reads every project, machine and task",
    "`orc_machines`: reads each dispatch machine's orc version",
    "`orc_backlog_answer`: answers a held or parked task, a decision, or a run at its gate",
    "`orc_attention`: reads the attention queue",
    "`orc_attention_answer`: answers a check-red, run-died, machine-unreached, or pr-ready item",
    "`orc_decision_board`: opens a page with one card per open question"
  ])
}
const move: Part = {
  title: "Move a task along",
  ...bullets(["`orc_backlog_stop`: stops a started run and closes the task stopped", "`orc_backlog_retry`: retries a failed or stopped task", "`orc_backlog_drop`: closes a new task as dropped", "`orc_backlog_send_back`: sends a closed task's PR back with your review", "`orc_backlog_note`: leaves a note on a task", "`orc_backlog_depend`: replaces the tasks it waits for", "`orc_backlog_thread`: reads a task's conversation"])
}
const land: Part = { title: "Merge", href: "merge", ...bullets(["`merge_task`: runs `orc merge`"]) }
const backlog: Part = { title: "The backlog", text: "The chat starts nothing. The beat starts a task once it has a priority.", href: "backlog" }

const wide = (): Drawing => {
  const body = [
    zone(8, 8, 170, 904, "You"),
    zone(198, 8, 380, 904, "`orc chat`"),
    zone(598, 8, 354, 904, "Eighteen tools, each one an `orc` command"),
    card(18, 42, 150, 160, say),
    card(18, 330, 150, 100, read),
    card(208, 42, 360, 96, model),
    card(208, 150, 360, 96, rules),
    card(208, 268, 360, 212, posts),
    card(608, 42, 334, 122, shape),
    card(608, 170, 334, 300, move),
    card(608, 476, 334, 260, answer),
    card(608, 742, 334, 70, land),
    card(608, 818, 334, 78, backlog),
    arrow([[168, 90], [206, 90]], "work"),
    arrow([[568, 90], [606, 90]], "work"),
    arrow([[606, 857], [570, 857]], "work"),
    arrow([[206, 380], [170, 380]], "work")
  ]
  return svg("chat", 960, 920, title, desc, body)
}

export const chat = (): readonly Drawing[] => [
  wide(),
  tall("chat", title, desc, [
    { label: "You", rows: [say] },
    { label: "`orc chat`", rows: [model, rules] },
    { label: "Eighteen tools, each one an `orc` command", rows: [shape, move, answer, land, { arrow: "work" }, backlog] },
    { label: "Back to you", rows: [posts, { arrow: "work" }, read] }
  ])
]
