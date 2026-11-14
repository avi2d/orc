import { askUserWord } from "../entities/review-gate/index"
import { taskKinds } from "../entities/backlog/index"
import { runDeliveries } from "../shared/config/index"
import { sandboxKinds } from "../shared/sandbox/index"
import type { HelpEntry } from "./help-format"

const choice = (values: ReadonlyArray<string>): string => "<" + values.join("|") + ">"

export const runHelp: HelpEntry = {
  usage: ["orc run [<task-file>] [--kind " + choice(taskKinds) + "] [--delivery " + choice(runDeliveries) + "] [--branch <name>] [--sandbox " + choice(sandboxKinds) + "] [--token-file <path>] [--provider <id>] [--instructions <path>] [--allow " + askUserWord + "] [--answer <id>=<text>]"],
  summary: "Run one task file in this checkout and end in a PR or a report",
  about: "Runs the task in the clean checkout you are in: Pi writes the change, the checks run, and no-mistakes reviews it and opens the PR. Give --branch with no task file to resume a stopped run on that branch.",
  options: [
    { flag: "--kind " + choice(taskKinds), meaning: "What the task ends in. ship ends in a PR, scout and task end in a report, and parent runs a parent's final check. Defaults to ship." },
    { flag: "--delivery " + choice(runDeliveries), meaning: "How a ship task reaches its PR. Defaults to no-mistakes, and direct-PR opens the PR with no review." },
    { flag: "--branch <name>", meaning: "The branch to commit to, or to resume. Defaults to orc/<run-id>." },
    { flag: "--sandbox " + choice(sandboxKinds), meaning: "Where the agent runs. Defaults to nono, and none runs it on the host as you." },
    { flag: "--token-file <path>", meaning: "A file holding the provider token the run uses." },
    { flag: "--provider <id>", meaning: "The provider id from config.json the run must use." },
    { flag: "--instructions <path>", meaning: "A project instructions file handed to Pi." },
    { flag: "--allow " + askUserWord, meaning: "Decline every ask-user finding of the review and accept the rest, on a resume." },
    { flag: "--answer <id>=<text>", meaning: "Answer a review question or an ask-user finding by its id, on a resume. Give it once per answer." }
  ],
  examples: [
    "orc run ~/task.md --sandbox none",
    "orc run --branch orc/fix-login --answer question-1=\"keep the old flag\""
  ]
}

export const runsHelp: HelpEntry = {
  usage: ["orc runs [--json]"],
  summary: "List recent runs with their status and PR",
  about: "Lists the recent runs this home recorded, newest first, with each run's project, branch, status and PR.",
  options: [{ flag: "--json", meaning: "Print the runs as an orc.runs.v1 JSON document." }],
  examples: ["orc runs", "orc runs --json"]
}

export const showHelp: HelpEntry = {
  usage: ["orc show <run-id> [--json]"],
  summary: "Show one run step by step",
  about: "Shows one run step by step: each step's agent, session, signals, latest score and evidence. Take the run id from orc runs.",
  options: [{ flag: "--json", meaning: "Print the run as an orc.show.v1 JSON document, which gives each step its id." }],
  examples: ["orc show 20261114-001721-4889ea", "orc show 20261114-001721-4889ea --json"]
}

export const logHelp: HelpEntry = {
  usage: ["orc log <run-id> <step-id>"],
  summary: "Print the output of one step of a run",
  about: "Prints the log one step of a run wrote, such as agent.log for an implement step. Take the step id from orc show <run-id> --json.",
  options: [],
  examples: ["orc log 20261114-001721-4889ea 3"]
}

export const scoreHelp: HelpEntry = {
  usage: ["orc score <run-id> <step> <1 to 5> [<note>]"],
  summary: "Score one step of a run from 1 to 5",
  about: "Records a score from 1 to 5 for one step of a run, with an optional note, and orc show prints the latest score. Name the step as fix#1 for the first fix attempt, or by its id from orc show --json.",
  options: [],
  examples: ["orc score 20261114-001721-4889ea implement 4 \"clean, one stray comment\""]
}

export const refusalsHelp: HelpEntry = {
  usage: ["orc refusals [--json]"],
  summary: "Count the gates and rules past runs kept hitting",
  about: "Counts the runs that hit each gate, and each rule where the failure names a stable rule code.",
  options: [{ flag: "--json", meaning: "Print the counts as an orc.refusals.v1 JSON document." }],
  examples: ["orc refusals"]
}

export const chatHelp: HelpEntry = {
  usage: ["orc chat"],
  summary: "Talk to the orchestrator, which adds, holds and answers tasks",
  about: "Starts Pi on the model models.orchestrator names in config.json, with tools that add, hold, edit and answer backlog tasks and merge their PRs. It posts each closed task and event as it lands.",
  options: [],
  examples: ["orc chat"]
}

export const appHelp: HelpEntry = {
  usage: ["orc app install"],
  summary: "Install the orc mods and layout into the Herdr App",
  about: "Holds the commands for the Herdr App, which shows the backlog, the runs and the machines in tabs.",
  options: [],
  examples: ["orc app install"]
}

export const appInstallHelp: HelpEntry = {
  usage: ["orc app install"],
  summary: "Copy the orc mods and layout into the Herdr App",
  about: "Builds the orc mods from this checkout when it has their sources, and copies them and the layout into ~/.config/herdr-app. Run it again after each orc upgrade.",
  options: [],
  examples: ["orc app install"]
}
