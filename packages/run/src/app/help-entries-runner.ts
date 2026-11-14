import type { HeavyWord } from "./dispatch-args"
import type { RunnerVerb } from "./dispatch-args-runner"
import type { HelpEntry, HelpOption } from "./help-format"

const reach = "[-- <command that runs orc there>]"
const reachOption: HelpOption = { flag: "-- <command>", meaning: "Run it on another machine through this command, such as ssh linux-box orc." }
const labelOption: HelpOption = { flag: "--label <label>", meaning: "The pueue label of another home's run. Defaults to this home's label for the task." }

export const runnerHelp: HelpEntry = {
  usage: ["orc runner <subcommand> [<args>]"],
  summary: "Queue, renew, read and stop task runs through pueue",
  about: "The commands the beat runs on each machine to hand a task to pueue, keep its token fresh, read how its run went and stop it. You run orc runner result and orc runner kill yourself.",
  options: [],
  examples: ["orc runner result orc-9", "orc runner kill orc-9"]
}

export const runnerVerbHelp: Record<RunnerVerb, HelpEntry> = {
  start: {
    usage: ["orc runner start " + reach],
    summary: "Queue the beat's task in pueue as an orc run",
    about: "The start command a machine names in dispatch.json. It reads the task from the beat's ORC_TASK_* variables and queues orc run in the project's checkout on branch orc/<task-id>.",
    options: [reachOption],
    examples: ["orc runner start", "orc runner start -- ssh linux-box orc"]
  },
  queue: {
    usage: ["orc runner queue"],
    summary: "Queue a task read as JSON on standard input",
    about: "The far side of orc runner start -- <command>. It reads the task as JSON on standard input, so the task text never passes through a remote shell.",
    options: [],
    examples: ["orc runner queue < task.json"]
  },
  renew: {
    usage: ["orc runner renew " + reach],
    summary: "Replace the token a queued task holds",
    about: "Reads a task and its fresh token as JSON on standard input and replaces the token the task holds.",
    options: [reachOption],
    examples: ["orc runner renew -- ssh linux-box orc < renewal.json"]
  },
  hold: {
    usage: ["orc runner hold <task-id> [--label <label>] -- <run command>"],
    summary: "Run a task's command once its token is live",
    about: "What pueue runs for a task with a token. It starts the run only while the token is live, and otherwise waits for a fresh one.",
    options: [labelOption, { flag: "-- <run command>", meaning: "The orc run command to start. Required." }],
    examples: ["orc runner hold orc-9 -- orc run ~/.orc/runner/orc-9.md --sandbox none"]
  },
  token: {
    usage: ["orc runner token <claude-credentials.json>"],
    summary: "Print a Claude credentials file as a token document",
    about: "A token command for dispatch.json. It reads a file in Claude Code's credentials shape and prints an orc.token.v1 document, only into a pipe.",
    options: [],
    examples: ["orc runner token ~/.claude/.credentials.json > token.json"]
  },
  result: {
    usage: ["orc runner result <task-id> [--json] [--label <label>] [--stdin-label] " + reach],
    summary: "Show pueue's state and the latest run of a task",
    about: "Names pueue's state for the task and the latest orc run on orc/<task-id> with its PR.",
    options: [
      { flag: "--json", meaning: "Print the result as an orc.runner.v1 JSON document." },
      labelOption,
      { flag: "--stdin-label", meaning: "Read the label as JSON on standard input, as a forwarded read sends it." },
      reachOption
    ],
    examples: ["orc runner result orc-9", "orc runner result orc-9 --json -- ssh linux-box orc"]
  },
  kill: {
    usage: ["orc runner kill <task-id> [--label <label>] [--stdin-label]"],
    summary: "Stop a task's run on this machine",
    about: "Kills the running pueue task for the task, or removes it while still queued, and marks its orc runs stopped. The next beat closes the task stopped.",
    options: [labelOption, { flag: "--stdin-label", meaning: "Read the label as JSON on standard input, as a forwarded kill sends it." }],
    examples: ["orc runner kill orc-9"]
  },
  answer: {
    usage: ["orc runner answer <task-id>"],
    summary: "Hand answers to a run waiting at its review gate",
    about: "Reads answers as JSON on standard input and writes them into the waiting run's answers.json.",
    options: [],
    examples: ["orc runner answer orc-9 < answers.json"]
  },
  load: {
    usage: ["orc runner load"],
    summary: "Print this machine's load and heavy queue",
    about: "Prints the five-minute load average the beat compares against a load limit, then the calls queued in the heavy queue.",
    options: [],
    examples: ["orc runner load"]
  }
}

export const heavyHelp: HelpEntry = {
  usage: ["orc heavy <subcommand>"],
  summary: "Check and watch the queue of heavy tool calls",
  about: "Each machine queues heavy calls such as test runs and builds through stand-ins, one at a time, so two of them never overload the machine together.",
  options: [],
  examples: ["orc heavy check"]
}

export const heavyVerbHelp: Record<HeavyWord, HelpEntry> = {
  path: {
    usage: ["orc heavy path"],
    summary: "Create the heavy tool stand-ins and print their folder",
    about: "Writes a stand-in for each heavy tool into ~/.orc/heavy/bin and prints that folder.",
    options: [],
    examples: ["orc heavy path"]
  },
  check: {
    usage: ["orc heavy check [--json]"],
    summary: "Read the heavy queue's slots, calls and bypasses",
    about: "Prints the slots, the running calls, the queued calls with their ages, and the bypasses.",
    options: [{ flag: "--json", meaning: "Print the same report as JSON." }],
    examples: ["orc heavy check", "orc heavy check --json"]
  },
  watch: {
    usage: ["orc heavy watch"],
    summary: "Arm the watchdog for stalled heavy calls",
    about: "Arms the watchdog that reports stalled calls and queue slips. orc runner start arms it for you.",
    options: [],
    examples: ["orc heavy watch"]
  },
  "watch-once": {
    usage: ["orc heavy watch-once"],
    summary: "Run one watchdog pass and print its counts",
    about: "Runs one pass of the heavy queue watchdog and prints what it counted.",
    options: [],
    examples: ["orc heavy watch-once"]
  }
}
