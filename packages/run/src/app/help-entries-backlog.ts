import { taskKinds } from "../entities/backlog/index"
import { mergeBases } from "../entities/pull-request/index"
import type { BacklogVerb } from "./dispatch-args"
import type { HelpEntry } from "./help-format"

export const backlogHelp: HelpEntry = {
  usage: ["orc backlog [--json]", "orc backlog <subcommand> [<args>]"],
  summary: "See the backlog, and add, hold, answer or close its tasks",
  about: "With no subcommand, prints the new, taken and closed tasks beside the projects and each machine's busy slots. The backlog lives in ~/.orc/backlog on the machine that runs orc beat.",
  options: [{ flag: "--json", meaning: "Print the backlog as an orc.backlog.v1 JSON document." }],
  examples: ["orc backlog", "orc backlog add orc ~/task.md"]
}

export const backlogVerbHelp: Record<BacklogVerb, HelpEntry> = {
  add: {
    usage: ["orc backlog add <project> <task-file|-> [--kind <" + taskKinds.join("|") + ">] [--internal] [--machine <name>] [--parent <task-id>] [--depends-on <task-id>]"],
    summary: "Add a task to the backlog",
    about: "Adds a task for a project that projects.json names, and prints its new id, such as orc-9. Give - as the task file to read the task from standard input.",
    options: [
      { flag: "--kind <" + taskKinds.join("|") + ">", meaning: "What the task ends in. Defaults to ship, or to the kind the task file names." },
      { flag: "--internal", meaning: "Mark a ship task internal-only, which a no-mistakes-prod-only project ships as direct-PR." },
      { flag: "--machine <name>", meaning: "Run the task on this machine only." },
      { flag: "--parent <task-id>", meaning: "Add the task as a child of a new parent task." },
      { flag: "--depends-on <task-id>", meaning: "A task this one waits for. Give it once per task." }
    ],
    examples: ["orc backlog add orc ~/task.md --machine linux-box", "orc backlog add orc ~/part.md --parent orc-12 --depends-on orc-13"]
  },
  edit: {
    usage: ["orc backlog edit <task-id> <task-file|->"],
    summary: "Replace the text of a task that has not started",
    about: "Replaces the title and the body of a new or held task and keeps its id, kind, hold, dependencies and parked questions. Give - to read the text from standard input.",
    options: [],
    examples: ["orc backlog edit orc-9 ~/task.md"]
  },
  close: {
    usage: ["orc backlog close <task-id> <done|failed> [<reason>]"],
    summary: "Close a task by hand as done or failed",
    about: "Closes a started task as done or failed, with an optional reason, for a machine whose start command orc does not run.",
    options: [],
    examples: ["orc backlog close orc-9 failed \"the machine was rebuilt\""]
  },
  stop: {
    usage: ["orc backlog stop <task-id>"],
    summary: "Kill a task's run and close the task stopped",
    about: "Kills the task's run through the machine that started it and closes the task stopped. Run it where the backlog lives.",
    options: [],
    examples: ["orc backlog stop orc-9"]
  },
  posted: {
    usage: ["orc backlog posted <task-id|event-key>"],
    summary: "Mark a closed task or an event as posted to the chat",
    about: "Records that the chat posted a closed task or an event, so no later chat posts it again.",
    options: [],
    examples: ["orc backlog posted orc-9"]
  },
  hold: {
    usage: ["orc backlog hold <task-id> --reason <text> [--until <YYYY-MM-DD>] [--question <text>]"],
    summary: "Keep a new task back until you answer it",
    about: "Holds a new task for a decision of yours, so the beat does not start it until you answer with orc backlog answer.",
    options: [
      { flag: "--reason <text>", meaning: "Why the task waits for you. Required." },
      { flag: "--until <YYYY-MM-DD>", meaning: "The date you mean to answer by. A past date releases nothing." },
      { flag: "--question <text>", meaning: "One decision to answer, named question-1 onward. Give it once per question." }
    ],
    examples: ["orc backlog hold orc-9 --reason \"pick the API\" --until 2026-12-01", "orc backlog hold orc-9 --reason \"two calls\" --question \"REST or gRPC?\""]
  },
  answer: {
    usage: ["orc backlog answer <task-id> [--expect <held|parked>] [--generation <n>] <words|question-id=text>"],
    summary: "Answer a held or parked task",
    about: "Answers a held task, a parked run's question or a run waiting at its gate. Give question-id=text to answer one open question, or plain words to answer the hold.",
    options: [
      { flag: "--expect <held|parked>", meaning: "Answer only when the task waits in this decision, so a stale answer is refused." },
      { flag: "--generation <n>", meaning: "The hold generation the answer is for. Needed with --expect held." }
    ],
    examples: ["orc backlog answer orc-9 use the REST API", "orc backlog answer orc-9 question-1=REST"]
  },
  note: {
    usage: ["orc backlog note <task-id> <words>"],
    summary: "Leave a note on a task",
    about: "Appends a note to the task's notes file. A note holds nothing and answers nothing, so it never changes when the beat starts the task.",
    options: [],
    examples: ["orc backlog note orc-9 the login page moved to /auth"]
  },
  depend: {
    usage: ["orc backlog depend <task-id> --on <task-id>[,<task-id>...]", "orc backlog depend <task-id> --clear"],
    summary: "Change the tasks a new task waits for",
    about: "Replaces the whole list of tasks a new or held task waits for, or empties it with --clear.",
    options: [
      { flag: "--on <task-id>[,<task-id>...]", meaning: "The comma-separated tasks it waits for." },
      { flag: "--clear", meaning: "Wait for no task." }
    ],
    examples: ["orc backlog depend orc-9 --on orc-7,orc-8", "orc backlog depend orc-9 --clear"]
  },
  plan: {
    usage: ["orc backlog plan <task-id> [--drop <task-id>]"],
    summary: "Show a parent task's plan, or drop a child from it",
    about: "Prints a parent task's count, how it was split, and one line per child with its state and what it waits on.",
    options: [{ flag: "--drop <task-id>", meaning: "Remove this new child from the plan." }],
    examples: ["orc backlog plan orc-12", "orc backlog plan orc-12 --drop orc-14"]
  }
}

export const attentionHelp: HelpEntry = {
  usage: ["orc attention [--json]", "orc attention answer <item-id> <words>"],
  summary: "See everything that waits on you or the decider",
  about: "With no subcommand, prints every open item in the attention queue, oldest first, such as review questions, red checks and PRs ready to merge.",
  options: [{ flag: "--json", meaning: "Print the queue as an orc.attention.v1 JSON document." }],
  examples: ["orc attention", "orc attention --json"]
}

export const attentionAnswerHelp: HelpEntry = {
  usage: ["orc attention answer <item-id> <words>"],
  summary: "Answer one item in the attention queue",
  about: "Closes one item with your words. A review question or an overdue wait is answered with orc backlog answer instead.",
  options: [],
  examples: ["orc attention answer orc-9.run-died restarted it by hand"]
}

export const beatHelp: HelpEntry = {
  usage: ["orc beat [--json]"],
  summary: "Start what can start and close what finished",
  about: "Reads the room on each machine, starts each task that waits on nothing, closes finished runs and relays answers. Run it from cron or launchd every few minutes.",
  options: [{ flag: "--json", meaning: "Print the beat as an orc.beat.v1 JSON document." }],
  examples: ["orc beat"]
}

export const mergeHelp: HelpEntry = {
  usage: ["orc merge <task-id> [--basis <" + mergeBases.join("|") + ">]"],
  summary: "Merge a closed task's PR once its checks are green",
  about: "Merges the PR of a closed task with a squash at the head it checked, and refuses a PR that is not open, not green or behind its base.",
  options: [{ flag: "--basis <" + mergeBases.join("|") + ">", meaning: "Why the merge is allowed. Defaults to captain-word, and yolo-green needs a project with yolo set." }],
  examples: ["orc merge orc-9", "orc merge orc-9 --basis yolo-green"]
}
