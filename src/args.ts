import { askUserWord, type QuestionAnswer } from "./no-mistakes"
export type OrcArgs =
  | { readonly kind: "PrintVersion" }
  | { readonly kind: "PrintHelp" }
  | { readonly kind: "ListRuns"; readonly json: boolean }
  | { readonly kind: "ShowRun"; readonly id: string; readonly json: boolean }
  | { readonly kind: "ScoreStep"; readonly runId: string; readonly step: string; readonly score: number; readonly note: string }
  | { readonly kind: "RunAgent"; readonly taskFile: string | null; readonly branch: string | undefined; readonly allow: ReadonlyArray<typeof askUserWord>; readonly answers: ReadonlyArray<QuestionAnswer> }
  | { readonly kind: "UsageError"; readonly detail: string }
const questionPrefix = "question-"
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
  | { readonly kind: "ok"; readonly branch: string | undefined; readonly allow: ReadonlyArray<typeof askUserWord>; readonly answers: ReadonlyArray<QuestionAnswer>; readonly kept: ReadonlyArray<string> }
  | { readonly kind: "error"; readonly detail: string }
type AnswerParse =
  | { readonly kind: "ok"; readonly value: QuestionAnswer }
  | { readonly kind: "error"; readonly detail: string }
const parseAnswerAssignment = (raw: string): AnswerParse => {
  const cut = raw.indexOf("=")
  if (cut === -1) {
    return { kind: "error", detail: "orc run takes question-id=text after --answer" }
  }
  const question = raw.slice(0, cut)
  const answer = raw.slice(cut + 1)
  if (question === "" || answer === "") {
    return { kind: "error", detail: "orc run takes question-id=text after --answer" }
  }
  if (!question.startsWith(questionPrefix) || question.length === questionPrefix.length || /\s/.test(question)) {
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
const takeBranchName = (rest: readonly string[], index: number, taken: string | undefined): string | null => {
  const name = rest[index + 1] ?? ""
  return taken !== undefined || name === "" || name.startsWith("--") ? null : name
}
interface RunFlags {
  branch: string | undefined
  readonly allow: Array<typeof askUserWord>
  readonly answers: Array<QuestionAnswer>
  readonly seen: Set<string>
}
type FlagTake = { readonly kind: "taken" } | { readonly kind: "error"; readonly detail: string }
const valueFlags = new Set(["--branch", "--allow", "--answer"])
const takeValueFlag = (rest: readonly string[], index: number, flags: RunFlags): FlagTake => {
  if (rest[index] === "--branch") {
    const name = takeBranchName(rest, index, flags.branch)
    if (name === null) {
      return { kind: "error", detail: "unexpected argument: --branch" }
    }
    flags.branch = name
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
  const flags: RunFlags = { branch: undefined, allow: [], answers: [], seen: new Set() }
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
  return { kind: "ok", branch: flags.branch, allow: flags.allow, answers: flags.answers, kept }
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
  const taskFile = split.kept.length === 1 ? split.kept[0] : null
  return { kind: "RunAgent", taskFile, branch: split.branch, allow: split.allow, answers: split.answers }
}
export const parseArgs = (args: readonly string[]): OrcArgs => {
  if (args.length === 0) {
    return { kind: "UsageError", detail: "orc takes one flag" }
  }
  const [first, ...rest] = args
  if (first === "runs") {
    if (rest.length === 0) {
      return { kind: "ListRuns", json: false }
    }
    const [flag, ...extra] = rest
    if (flag !== "--json") {
      return { kind: "UsageError", detail: `unexpected argument: ${flag}` }
    }
    if (extra.length > 0) {
      return { kind: "UsageError", detail: `unexpected argument: ${extra[0]}` }
    }
    return { kind: "ListRuns", json: true }
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
