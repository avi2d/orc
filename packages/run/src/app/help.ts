import { type CommandWord, commandWords, isCommandWord } from "./args"
import { appHelp, appInstallHelp, chatHelp, logHelp, refusalsHelp, runHelp, runsHelp, scoreHelp, showHelp } from "./help-entries-run"
import { attentionAnswerHelp, attentionHelp, backlogHelp, backlogVerbHelp, beatHelp, mergeHelp } from "./help-entries-backlog"
import { heavyHelp, heavyVerbHelp, runnerHelp, runnerVerbHelp } from "./help-entries-runner"
import { formatHelp, formatOverview, type HelpEntry, type OverviewGroup, type Row, usageBlock, wrap, terminalWidth } from "./help-format"

const groups = ["Run a task:", "Runs and their results:", "The backlog and the beat:", "The runner:", "Chat and the app:"] as const
type Group = typeof groups[number]

const commandGroup: Record<CommandWord, Group> = {
  run: "Run a task:",
  runs: "Runs and their results:",
  show: "Runs and their results:",
  log: "Runs and their results:",
  score: "Runs and their results:",
  refusals: "Runs and their results:",
  backlog: "The backlog and the beat:",
  attention: "The backlog and the beat:",
  beat: "The backlog and the beat:",
  merge: "The backlog and the beat:",
  runner: "The runner:",
  heavy: "The runner:",
  chat: "Chat and the app:",
  app: "Chat and the app:"
}

const commandHelp: Record<CommandWord, HelpEntry> = {
  run: runHelp,
  runs: runsHelp,
  show: showHelp,
  log: logHelp,
  score: scoreHelp,
  refusals: refusalsHelp,
  backlog: backlogHelp,
  attention: attentionHelp,
  beat: beatHelp,
  merge: mergeHelp,
  runner: runnerHelp,
  heavy: heavyHelp,
  chat: chatHelp,
  app: appHelp
}

const subcommandHelp: Partial<Record<CommandWord, Readonly<Record<string, HelpEntry>>>> = {
  backlog: backlogVerbHelp,
  runner: runnerVerbHelp,
  heavy: heavyVerbHelp,
  attention: { answer: attentionAnswerHelp },
  app: { install: appInstallHelp }
}

const about = "orc runs AI agent tasks across your machines and reports back."

const overviewGroups = (): Array<OverviewGroup> =>
  groups.map((group) => ({
    group,
    rows: commandWords.filter((name) => commandGroup[name] === group).map((name): Row => [name, commandHelp[name].summary])
  }))

export const overview = (): string => formatOverview(about, overviewGroups())

export interface HelpTopic {
  readonly path: string
  readonly entry: HelpEntry
  readonly subcommands: Readonly<Record<string, HelpEntry>>
}

const subcommandsOf = (command: CommandWord): Readonly<Record<string, HelpEntry>> => subcommandHelp[command] ?? {}

export const helpTopic = (words: ReadonlyArray<string>): HelpTopic | null => {
  const [first = "", second = ""] = words
  if (!isCommandWord(first)) {
    return null
  }
  const subcommands = subcommandsOf(first)
  const sub = Object.hasOwn(subcommands, second) ? subcommands[second] : undefined
  return sub === undefined
    ? { path: first, entry: commandHelp[first], subcommands }
    : { path: first + " " + second, entry: sub, subcommands: {} }
}

const subcommandRows = (subcommands: Readonly<Record<string, HelpEntry>>): Array<Row> =>
  Object.entries(subcommands).map(([name, entry]): Row => [name, entry.summary])

export const helpText = (words: ReadonlyArray<string>): string => {
  const topic = helpTopic(words)
  return topic === null ? overview() : formatHelp(topic.path, topic.entry, subcommandRows(topic.subcommands))
}

// Optimal string alignment distance, so a swapped pair of letters such as rnu for run counts as one edit.
const editDistance = (from: string, to: string): number => {
  const rows = Array.from({ length: from.length + 1 }, (_row, i) => Array.from({ length: to.length + 1 }, (_cell, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i <= from.length; i += 1) {
    for (let j = 1; j <= to.length; j += 1) {
      const cost = from[i - 1] === to[j - 1] ? 0 : 1
      const best = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost)
      const swapped = i > 1 && j > 1 && from[i - 1] === to[j - 2] && from[i - 2] === to[j - 1]
      rows[i][j] = swapped ? Math.min(best, rows[i - 2][j - 2] + 1) : best
    }
  }
  return rows[from.length][to.length]
}

export const closestWord = (word: string, candidates: ReadonlyArray<string>): string | null => {
  if (word === "" || word.startsWith("-")) {
    return null
  }
  const ranked = candidates.map((candidate) => ({ candidate, distance: editDistance(word, candidate) })).toSorted((a, b) => a.distance - b.distance)
  const best = ranked.at(0)
  const next = ranked.at(1)
  if (best === undefined || best.distance === 0 || best.distance > 2 || best.distance * 2 > word.length) {
    return null
  }
  return next !== undefined && next.distance === best.distance ? null : best.candidate
}

const suggestion = (words: ReadonlyArray<string>, topic: HelpTopic | null): string | null => {
  const [first = "", second = ""] = words
  if (topic === null) {
    const close = closestWord(first, commandWords)
    return close === null ? null : "orc " + close
  }
  const close = topic.path === first ? closestWord(second, Object.keys(topic.subcommands)) : null
  return close === null ? null : "orc " + first + " " + close
}

const topicUsage = (topic: HelpTopic): Array<string> => {
  const names = Object.keys(topic.subcommands)
  return names.length === 0
    ? usageBlock(topic.entry.usage)
    : [...usageBlock(topic.entry.usage), ...wrap("Subcommands: " + names.join(", "), terminalWidth, "", "  ")]
}

export const usageErrorText = (detail: string, words: ReadonlyArray<string>): string => {
  const topic = helpTopic(words)
  const close = suggestion(words, topic)
  return [
    ...wrap(detail, terminalWidth),
    ...(close === null ? [] : ["Did you mean " + close + "?"]),
    "",
    ...(topic === null ? usageBlock(["orc <command> [<args>]"]) : topicUsage(topic)),
    "",
    topic === null ? "Run orc --help to see every command." : "Run orc " + topic.path + " --help for more."
  ].join("\n")
}
