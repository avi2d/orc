import { type DispatchArgs, parseDispatchArgs } from "./dispatch/args"
import { askUserWord, type QuestionAnswer } from "./entities/review-gate/index"
import { isTaskKind, type TaskKind, unknownKind } from "./entities/backlog/index"
import { isRunDelivery, type RunDelivery, runDeliveries } from "./shared/config/index"
import { sandboxKinds, type SandboxKind } from "./shared/sandbox/index"
export const defaultSandbox: SandboxKind = "nono"
export type OrcArgs =
  | { readonly kind: "PrintVersion" }
  | { readonly kind: "PrintHelp" }
  | { readonly kind: "ListRuns"; readonly json: boolean }
  | { readonly kind: "ListRefusals"; readonly json: boolean }
  | { readonly kind: "ShowRun"; readonly id: string; readonly json: boolean }
  | { readonly kind: "ScoreStep"; readonly runId: string; readonly step: string; readonly score: number; readonly note: string }
  | { readonly kind: "RunAgent"; readonly taskFile: string | null; readonly taskKind: TaskKind; readonly delivery: RunDelivery; readonly branch: string | undefined; readonly sandbox: SandboxKind | undefined; readonly tokenFile: string | undefined; readonly provider: string | undefined; readonly instructions: string | undefined; readonly allow: ReadonlyArray<typeof askUserWord>; readonly answers: ReadonlyArray<QuestionAnswer> }
  | { readonly kind: "Dispatch"; readonly args: Exclude<DispatchArgs, { readonly kind: "UsageError" }> }
  | { readonly kind: "Chat" }
  | { readonly kind: "InstallApp" }
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

type RunSplit =
  | { readonly kind: "ok"; readonly taskKind: TaskKind; readonly delivery: RunDelivery; readonly branch: string | undefined; readonly sandbox: SandboxKind | undefined; readonly tokenFile: string | undefined; readonly provider: string | undefined; readonly instructions: string | undefined; readonly allow: ReadonlyArray<typeof askUserWord>; readonly answers: ReadonlyArray<QuestionAnswer>; readonly kept: ReadonlyArray<string> }
  | { readonly kind: "error"; readonly detail: string }
type AnswerParse =
  | { readonly kind: "ok"; readonly value: QuestionAnswer }
  | { readonly kind: "error"; readonly detail: string }
const answerShape = "orc run takes id=text after --answer, with the id of a question or an ask-user finding"
const parseAnswerAssignment = (raw: string): AnswerParse => {
  const cut = raw.indexOf("=")
  if (cut === -1) {
    return { kind: "error", detail: answerShape }
  }
  const question = raw.slice(0, cut)
  const answer = raw.slice(cut + 1)
  if (question === "" || answer === "") {
    return { kind: "error", detail: answerShape }
  }
  if (/\s/.test(question)) {
    return { kind: "error", detail: "unknown question for --answer: " + question }
  }
  return { kind: "ok", value: { question, answer } }
}
type AllowTake =
  | { readonly kind: "ok"; readonly word: typeof askUserWord }
  | { readonly kind: "error"; readonly detail: string }
const takeAllowWord = (rest: readonly string[], index: number): AllowTake => {
  const word = rest[index + 1] ?? ""
  if (word === "" || word.startsWith("--")) {
    return { kind: "error", detail: "orc run takes a word after --allow" }
  }
  return word === askUserWord ? { kind: "ok", word } : { kind: "error", detail: "unknown word for --allow: " + word }
}
type AnswerTake =
  | { readonly kind: "ok"; readonly value: QuestionAnswer }
  | { readonly kind: "error"; readonly detail: string }
const takeAnswerValue = (rest: readonly string[], index: number, seen: Set<string>): AnswerTake => {
  const raw = rest[index + 1] ?? ""
  if (raw === "" || raw.startsWith("--")) {
    return { kind: "error", detail: "orc run takes an answer after --answer" }
  }
  const parsed = parseAnswerAssignment(raw)
  if (parsed.kind === "error") {
    return parsed
  }
  if (seen.has(parsed.value.question)) {
    return { kind: "error", detail: "duplicate answer for --answer: " + parsed.value.question }
  }
  seen.add(parsed.value.question)
  return parsed
}
const takeFlagValue = (rest: readonly string[], index: number, taken: string | undefined): string | null => {
  const name = rest[index + 1] ?? ""
  return taken !== undefined || name === "" || name.startsWith("--") ? null : name
}
const takeSandboxKind = (rest: readonly string[], index: number, taken: SandboxKind | undefined): SandboxKind | null => {
  const name = rest[index + 1] ?? ""
  return taken === undefined ? sandboxKinds.find((kind) => kind === name) ?? null : null
}
interface RunFlags {
  taskKind: TaskKind | undefined
  delivery: RunDelivery | undefined
  branch: string | undefined
  sandbox: SandboxKind | undefined
  tokenFile: string | undefined
  provider: string | undefined
  instructions: string | undefined
  readonly allow: Array<typeof askUserWord>
  readonly answers: Array<QuestionAnswer>
  readonly seen: Set<string>
}
type FlagTake = { readonly kind: "taken" } | { readonly kind: "error"; readonly detail: string }
type StringFlag = "branch" | "tokenFile" | "provider" | "instructions"
const stringFlags: ReadonlyArray<{ readonly flag: string; readonly key: StringFlag; readonly detail: string }> = [
  { flag: "--branch", key: "branch", detail: "unexpected argument: --branch" },
  { flag: "--token-file", key: "tokenFile", detail: "orc run takes --token-file once, with a path" },
  { flag: "--provider", key: "provider", detail: "orc run takes --provider once, with a provider id" },
  { flag: "--instructions", key: "instructions", detail: "orc run takes --instructions once, with a file path" }
]
const valueFlags = new Set(["--kind", "--delivery", "--sandbox", "--allow", "--answer", ...stringFlags.map((entry) => entry.flag)])
const takeTaskKind = (rest: readonly string[], index: number, flags: RunFlags): FlagTake => {
  const word = rest[index + 1] ?? ""
  if (flags.taskKind !== undefined || word === "" || word.startsWith("--")) {
    return { kind: "error", detail: "orc run takes --kind once, with ship, scout, task or parent" }
  }
  if (!isTaskKind(word)) {
    return { kind: "error", detail: unknownKind(word) }
  }
  flags.taskKind = word
  return { kind: "taken" }
}
const takeDelivery = (rest: readonly string[], index: number, flags: RunFlags): FlagTake => {
  const word = rest[index + 1] ?? ""
  if (flags.delivery !== undefined || !isRunDelivery(word)) {
    return { kind: "error", detail: "orc run takes --delivery once, with " + runDeliveries.join(" or ") }
  }
  flags.delivery = word
  return { kind: "taken" }
}
const takeValueFlag = (rest: readonly string[], index: number, flags: RunFlags): FlagTake => {
  const named = stringFlags.find((entry) => entry.flag === rest[index])
  if (named !== undefined) {
    const value = takeFlagValue(rest, index, flags[named.key])
    if (value === null) {
      return { kind: "error", detail: named.detail }
    }
    flags[named.key] = value
    return { kind: "taken" }
  }
  if (rest[index] === "--kind") {
    return takeTaskKind(rest, index, flags)
  }
  if (rest[index] === "--delivery") {
    return takeDelivery(rest, index, flags)
  }
  if (rest[index] === "--sandbox") {
    const kind = takeSandboxKind(rest, index, flags.sandbox)
    if (kind === null) {
      return { kind: "error", detail: "orc run takes --sandbox once, with " + sandboxKinds.join(" or ") }
    }
    flags.sandbox = kind
    return { kind: "taken" }
  }
  if (rest[index] === "--allow") {
    const taken = takeAllowWord(rest, index)
    if (taken.kind === "error") {
      return taken
    }
    flags.allow.push(taken.word)
    return { kind: "taken" }
  }
  const taken = takeAnswerValue(rest, index, flags.seen)
  if (taken.kind === "error") {
    return taken
  }
  flags.answers.push(taken.value)
  return { kind: "taken" }
}
const splitRunArgs = (rest: readonly string[]): RunSplit => {
  const flags: RunFlags = { taskKind: undefined, delivery: undefined, branch: undefined, sandbox: undefined, tokenFile: undefined, provider: undefined, instructions: undefined, allow: [], answers: [], seen: new Set() }
  const kept: Array<string> = []
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? ""
    if (!valueFlags.has(token)) {
      kept.push(token)
      continue
    }
    const taken = takeValueFlag(rest, index, flags)
    if (taken.kind === "error") {
      return taken
    }
    index += 1
  }
  return { kind: "ok", taskKind: flags.taskKind ?? "ship", delivery: flags.delivery ?? "no-mistakes", branch: flags.branch, sandbox: flags.sandbox, tokenFile: flags.tokenFile, provider: flags.provider, instructions: flags.instructions, allow: flags.allow, answers: flags.answers, kept }
}
const parseRunArgs = (rest: readonly string[]): OrcArgs => {
  const split = splitRunArgs(rest)
  if (split.kind === "error") {
    return { kind: "UsageError", detail: split.detail }
  }
  if (split.kept.length === 0 && split.branch === undefined) {
    return { kind: "UsageError", detail: "orc run takes a task file" }
  }
  if (split.kept.length > 1) {
    return { kind: "UsageError", detail: `unexpected argument: ${split.kept[1]}` }
  }
  if (split.taskKind !== "ship" && (split.allow.length > 0 || split.answers.length > 0)) {
    return { kind: "UsageError", detail: "orc run --kind " + split.taskKind + " ends in a report, so it takes no --allow or --answer" }
  }
  if (split.taskKind !== "ship" && split.delivery !== "no-mistakes") {
    return { kind: "UsageError", detail: "orc run --kind " + split.taskKind + " ends in a report, so it takes no --delivery" }
  }
  const taskFile = split.kept.length === 1 ? split.kept[0] : null
  return { kind: "RunAgent", taskFile, taskKind: split.taskKind, delivery: split.delivery, branch: split.branch, sandbox: split.sandbox, tokenFile: split.tokenFile, provider: split.provider, instructions: split.instructions, allow: split.allow, answers: split.answers }
}
const parseJsonListArgs = (rest: readonly string[], kind: "ListRuns" | "ListRefusals"): OrcArgs => {
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
const helpFlags = new Set(["--help", "-h"])
const holdValueFlags = new Set(["--reason", "--until"])
const scanWords = (rest: readonly string[]): readonly string[] => {
  if (rest[0] === "hold") {
    return rest.filter((_word, index) => index < 1 || !holdValueFlags.has(rest[index - 1] ?? ""))
  }
  if (rest[0] === "answer") {
    return rest.slice(0, 2)
  }
  return rest
}
// Words after "--" are a command orc passes on, so a --help there is that command's.
const asksForHelp = (rest: readonly string[]): boolean => {
  const words = scanWords(rest)
  const end = words.indexOf("--")
  return (end === -1 ? words : words.slice(0, end)).some((word) => helpFlags.has(word))
}
const subcommands = new Set(["app", "runs", "refusals", "show", "score", "run", "chat", "backlog", "attention", "beat", "runner", "merge", "heavy"])
const dispatchSubcommands = ["backlog", "attention", "beat", "runner", "merge", "heavy"] as const
type DispatchSubcommand = typeof dispatchSubcommands[number]
const isDispatchSubcommand = (word: string): word is DispatchSubcommand => (dispatchSubcommands as ReadonlyArray<string>).includes(word)
const parseDispatchCommand = (first: string, rest: readonly string[]): OrcArgs | null => {
  if (!isDispatchSubcommand(first)) {
    return null
  }
  const dispatch = parseDispatchArgs(first, rest)
  return dispatch.kind === "UsageError" ? dispatch : { kind: "Dispatch", args: dispatch }
}
const parseAppArgs = (rest: readonly string[]): OrcArgs =>
  rest.length === 1 && rest[0] === "install" ? { kind: "InstallApp" } : { kind: "UsageError", detail: "orc app takes install" }
const parseChatArgs = (rest: readonly string[]): OrcArgs =>
  rest.length === 0 ? { kind: "Chat" } : { kind: "UsageError", detail: `orc chat takes no argument: ${rest[0]}` }
const parseFlagArgs = (first: string, rest: readonly string[]): OrcArgs => {
  const dispatchCommand = parseDispatchCommand(first, rest)
  if (dispatchCommand !== null) {
    return dispatchCommand
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
      return { kind: "PrintHelp" }
    }
    default: {
      return { kind: "UsageError", detail: `unknown flag: ${first}` }
    }
  }
}
const parseWords = (args: readonly string[]): OrcArgs => {
  if (args.length === 0) {
    return { kind: "UsageError", detail: "orc takes one flag" }
  }
  const [first, ...rest] = args
  if (first === "runs") {
    return parseJsonListArgs(rest, "ListRuns")
  }
  if (first === "refusals") {
    return parseJsonListArgs(rest, "ListRefusals")
  }
  if (first === "show") {
    return parseShowArgs(rest)
  }
  if (first === "score") {
    return parseScoreArgs(rest)
  }
  if (first === "run") {
    return parseRunArgs(rest)
  }
  if (first === "app") {
    return parseAppArgs(rest)
  }
  if (first === "chat") {
    return parseChatArgs(rest)
  }
  return parseFlagArgs(first, rest)
}
export const parseArgs = (args: readonly string[]): OrcArgs =>
  subcommands.has(args[0] ?? "") && asksForHelp(args.slice(1)) ? { kind: "PrintHelp" } : parseWords(args)
