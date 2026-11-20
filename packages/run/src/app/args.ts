import { type DispatchArgs, parseDispatchArgs } from "./dispatch-args"
import { parseRunArgs, type RunAgentArgs } from "../features/running-a-task/index"
export type OrcArgs =
  | { readonly kind: "PrintVersion" }
  | { readonly kind: "ShowVersion" }
  | { readonly kind: "ListMachines" }
  | { readonly kind: "PrintHelp"; readonly words: ReadonlyArray<string> }
  | { readonly kind: "NoCommand" }
  | { readonly kind: "ListRuns"; readonly json: boolean; readonly local: boolean }
  | { readonly kind: "ListRefusals"; readonly json: boolean }
  | { readonly kind: "ShowRun"; readonly id: string; readonly json: boolean }
  | { readonly kind: "ShowStepLog"; readonly runId: string; readonly stepId: number }
  | { readonly kind: "ScoreStep"; readonly runId: string; readonly step: string; readonly score: number; readonly note: string }
  | RunAgentArgs
  | { readonly kind: "Dispatch"; readonly args: Exclude<DispatchArgs, { readonly kind: "UsageError" }> }
  | { readonly kind: "Chat"; readonly sessionFile: string | null }
  | { readonly kind: "InstallApp" }
  | { readonly kind: "Update"; readonly json: boolean }
  | { readonly kind: "UsageError"; readonly detail: string }
const parseShowArgs = (rest: readonly string[]): OrcArgs => {
  if (rest.length === 0) {
    return { kind: "UsageError", detail: "orc show takes a run id" }
  }
  const [id, ...flags] = rest
  if (flags.length === 0) {
    return { kind: "ShowRun", id, json: false }
  }
  const [flag, ...extra] = flags
  if (flag !== "--json") {
    return { kind: "UsageError", detail: `unexpected argument: ${flag}` }
  }
  if (extra.length > 0) {
    return { kind: "UsageError", detail: `unexpected argument: ${extra[0]}` }
  }
  return { kind: "ShowRun", id, json: true }
}
const parseLogArgs = (rest: readonly string[]): OrcArgs => {
  if (rest.length !== 2) {
    return { kind: "UsageError", detail: "orc log takes a run id and a step id from orc show --json" }
  }
  const [runId, stepText] = rest
  if (!/^[1-9][0-9]*$/.test(stepText)) {
    return { kind: "UsageError", detail: `orc log takes a step id from orc show --json, got "${stepText}"` }
  }
  return { kind: "ShowStepLog", runId, stepId: Number(stepText) }
}
const parseScoreArgs = (rest: readonly string[]): OrcArgs => {
  if (rest.length < 3) {
    return { kind: "UsageError", detail: "orc score takes a run id, a step name, a score from 1 to 5 and an optional note" }
  }
  if (rest.length > 4) {
    return { kind: "UsageError", detail: `unexpected argument for orc score: ${rest[4]}` }
  }
  const runId = rest[0]
  const step = rest[1]
  const scoreText = rest[2]
  if (!/^[1-5]$/.test(scoreText)) {
    return { kind: "UsageError", detail: `orc score takes a score from 1 to 5, got "${scoreText}"` }
  }
  const note = rest.length === 4 ? rest[3] : ""
  return { kind: "ScoreStep", runId, step, score: Number(scoreText), note }
}

const parseJsonListArgs = (rest: readonly string[], kind: "ListRefusals" | "Update"): OrcArgs => {
  if (rest.length === 0) {
    return { kind, json: false }
  }
  const [flag, ...extra] = rest
  if (flag !== "--json") {
    return { kind: "UsageError", detail: `unexpected argument: ${flag}` }
  }
  if (extra.length > 0) {
    return { kind: "UsageError", detail: `unexpected argument: ${extra[0]}` }
  }
  return { kind, json: true }
}
const parseRunsArgs = (rest: readonly string[]): OrcArgs => {
  if (rest.length === 0) {
    return { kind: "ListRuns", json: false, local: false }
  }
  const [flag, ...extra] = rest
  if (flag !== "--json") {
    return { kind: "UsageError", detail: `unexpected argument: ${flag}` }
  }
  if (extra.length === 0) {
    return { kind: "ListRuns", json: true, local: false }
  }
  if (extra.length === 1 && extra[0] === "--local") {
    return { kind: "ListRuns", json: true, local: true }
  }
  return { kind: "UsageError", detail: `unexpected argument: ${extra[0]}` }
}
const parseVersionArgs = (rest: readonly string[]): OrcArgs => {
  if (rest[0] !== "--json") {
    return rest.length === 0 ? { kind: "UsageError", detail: "orc version takes --json" } : { kind: "UsageError", detail: `unexpected argument: ${rest[0]}` }
  }
  if (rest.length === 1) {
    return { kind: "ShowVersion" }
  }
  if (rest.length === 2 && rest[1] === "--local") {
    return { kind: "ShowVersion" }
  }
  return { kind: "UsageError", detail: `unexpected argument: ${rest[1] === "--local" ? rest[2] : rest[1]}` }
}
const parseMachinesArgs = (rest: readonly string[]): OrcArgs => {
  if (rest.length === 1 && rest[0] === "--json") {
    return { kind: "ListMachines" }
  }
  return rest.length === 0 ? { kind: "UsageError", detail: "orc machines takes --json" } : { kind: "UsageError", detail: `unexpected argument: ${rest[0] === "--json" ? rest[1] : rest[0]}` }
}
const helpFlags = new Set(["--help", "-h"])
const holdValueFlags = new Set(["--reason", "--until"])
const answerValueFlags = new Set(["--expect", "--generation"])
const scanWords = (rest: readonly string[]): readonly string[] => {
  if (rest[0] === "hold") {
    return rest.filter((_word, index) => index < 1 || !holdValueFlags.has(rest[index - 1] ?? ""))
  }
  if (rest[0] === "answer") {
    return rest.filter((_word, index) => index < 2 || !answerValueFlags.has(rest[index - 1] ?? ""))
  }
  return rest
}
// Words after "--" are a command orc passes on, so a --help there is that command's.
const asksForHelp = (rest: readonly string[]): boolean => {
  const words = scanWords(rest)
  const end = words.indexOf("--")
  return (end === -1 ? words : words.slice(0, end)).some((word) => helpFlags.has(word))
}
const toDispatch = (command: Parameters<typeof parseDispatchArgs>[0], rest: readonly string[]): OrcArgs => {
  const dispatch = parseDispatchArgs(command, rest)
  return dispatch.kind === "UsageError" ? dispatch : { kind: "Dispatch", args: dispatch }
}

const appSubcommands = {
  install: (): OrcArgs => ({ kind: "InstallApp" })
} satisfies Record<string, () => OrcArgs>

export type AppWord = keyof typeof appSubcommands
const isAppWord = (word: string): word is AppWord => Object.hasOwn(appSubcommands, word)

const parseAppArgs = (rest: readonly string[]): OrcArgs => {
  const [word = ""] = rest
  return rest.length === 1 && isAppWord(word) ? appSubcommands[word]() : { kind: "UsageError", detail: "orc app takes install" }
}
const parseChatArgs = (rest: readonly string[]): OrcArgs => {
  if (rest.length === 0) {
    return { kind: "Chat", sessionFile: null }
  }
  const [flag, file = "", ...extra] = rest
  if (flag !== "--session") {
    return { kind: "UsageError", detail: `orc chat takes only --session <file>: ${flag}` }
  }
  if (file === "" || file.startsWith("--") || extra.length > 0) {
    return { kind: "UsageError", detail: "orc chat takes --session once, with a session file path" }
  }
  return { kind: "Chat", sessionFile: file }
}

const topLevelParsers = {
  run: parseRunArgs,
  runs: parseRunsArgs,
  show: parseShowArgs,
  log: parseLogArgs,
  score: parseScoreArgs,
  refusals: (rest: readonly string[]): OrcArgs => parseJsonListArgs(rest, "ListRefusals"),
  chat: parseChatArgs,
  app: parseAppArgs,
  update: (rest: readonly string[]): OrcArgs => parseJsonListArgs(rest, "Update"),
  backlog: (rest: readonly string[]): OrcArgs => toDispatch("backlog", rest),
  attention: (rest: readonly string[]): OrcArgs => toDispatch("attention", rest),
  beat: (rest: readonly string[]): OrcArgs => toDispatch("beat", rest),
  runner: (rest: readonly string[]): OrcArgs => toDispatch("runner", rest),
  merge: (rest: readonly string[]): OrcArgs => toDispatch("merge", rest),
  heavy: (rest: readonly string[]): OrcArgs => toDispatch("heavy", rest),
  version: parseVersionArgs,
  machines: parseMachinesArgs
} satisfies Record<string, (rest: readonly string[]) => OrcArgs>

export type CommandWord = keyof typeof topLevelParsers
export const isCommandWord = (word: string): word is CommandWord => Object.hasOwn(topLevelParsers, word)
export const commandWords: ReadonlyArray<CommandWord> = Object.keys(topLevelParsers).filter(isCommandWord)

const parseFlagArgs = (first: string, rest: readonly string[]): OrcArgs => {
  if (!first.startsWith("-")) {
    return { kind: "UsageError", detail: `unknown command: ${first}` }
  }
  if (rest.length > 0) {
    return { kind: "UsageError", detail: `unexpected argument: ${rest[0]}` }
  }
  switch (first) {
    case "--version": {
      return { kind: "PrintVersion" }
    }
    case "--help":
    case "-h": {
      return { kind: "PrintHelp", words: [] }
    }
    default: {
      return { kind: "UsageError", detail: `unknown flag: ${first}` }
    }
  }
}
const parseWords = (args: readonly string[]): OrcArgs => {
  if (args.length === 0) {
    return { kind: "NoCommand" }
  }
  const [first = "", ...rest] = args
  return isCommandWord(first) ? topLevelParsers[first](rest) : parseFlagArgs(first, rest)
}
export const parseArgs = (args: readonly string[]): OrcArgs =>
  isCommandWord(args[0] ?? "") && asksForHelp(args.slice(1)) ? { kind: "PrintHelp", words: args.slice(0, args.findIndex((word) => helpFlags.has(word))) } : parseWords(args)
