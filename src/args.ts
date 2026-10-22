import { askUserWord, type QuestionAnswer } from "./no-mistakes"
export type OrcArgs =
  | { readonly kind: "PrintVersion" }
  | { readonly kind: "PrintHelp" }
  | { readonly kind: "ListRuns"; readonly json: boolean }
  | { readonly kind: "ShowRun"; readonly id: string; readonly json: boolean }
  | { readonly kind: "RunAgent"; readonly taskFile: string | null; readonly branch: string | undefined; readonly allow: ReadonlyArray<string>; readonly answers: ReadonlyArray<QuestionAnswer> }
  | { readonly kind: "UsageError"; readonly detail: string }
const allowWords: ReadonlyArray<string> = [askUserWord]
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
type RunSplit =
  | { readonly kind: "ok"; readonly allow: ReadonlyArray<string>; readonly answers: ReadonlyArray<QuestionAnswer>; readonly kept: ReadonlyArray<string> }
  | { readonly kind: "error"; readonly detail: string }
const readAllowWord = (word: string): string | null =>
  word === "" || word.startsWith("--") ? null : (allowWords.includes(word) ? word : null)
const readAnswerAssignment = (raw: string): QuestionAnswer | null => {
  const cut = raw.indexOf("=")
  if (cut === -1) {
    return null
  }
  const question = raw.slice(0, cut)
  const answer = raw.slice(cut + 1)
  if (!question.startsWith(questionPrefix) || question.length === questionPrefix.length) {
    return null
  }
  if (/\s/.test(question) || answer === "") {
    return null
  }
  return { question, answer }
}
const answerErrorFor = (raw: string): string => {
  if (!raw.includes("=")) {
    return "orc run takes question-id=text after --answer"
  }
  const cut = raw.indexOf("=")
  const question = raw.slice(0, cut)
  const answer = raw.slice(cut + 1)
  if ((!question.startsWith(questionPrefix) || question.length === questionPrefix.length || /\s/.test(question)) && question !== "") {
    return "unknown question for --answer: " + question
  }
  if (question === "" || answer === "") {
    return "orc run takes question-id=text after --answer"
  }
  return "unknown question for --answer: " + question
}
const splitRunArgs = (rest: readonly string[]): RunSplit => {
  const allow: Array<string> = []
  const answers: Array<QuestionAnswer> = []
  const seen = new Set<string>()
  const kept: Array<string> = []
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? ""
    if (token === "--allow") {
      const word = rest[index + 1] ?? ""
      if (word === "" || word.startsWith("--")) {
        return { kind: "error", detail: "orc run takes a word after --allow" }
      }
      const named = readAllowWord(word)
      if (named === null) {
        return { kind: "error", detail: "unknown word for --allow: " + word }
      }
      allow.push(named)
      index += 1
      continue
    }
    if (token === "--answer") {
      const raw = rest[index + 1] ?? ""
      if (raw === "" || raw.startsWith("--")) {
        return { kind: "error", detail: "orc run takes an answer after --answer" }
      }
      const parsed = readAnswerAssignment(raw)
      if (parsed === null) {
        return { kind: "error", detail: answerErrorFor(raw) }
      }
      if (seen.has(parsed.question)) {
        return { kind: "error", detail: "duplicate answer for --answer: " + parsed.question }
      }
      seen.add(parsed.question)
      answers.push(parsed)
      index += 1
      continue
    }
    if (token.startsWith("--answer=")) {
      const raw = token.slice("--answer=".length)
      if (raw === "") {
        return { kind: "error", detail: "orc run takes an answer after --answer" }
      }
      const parsed = readAnswerAssignment(raw)
      if (parsed === null) {
        return { kind: "error", detail: answerErrorFor(raw) }
      }
      if (seen.has(parsed.question)) {
        return { kind: "error", detail: "duplicate answer for --answer: " + parsed.question }
      }
      seen.add(parsed.question)
      answers.push(parsed)
      continue
    }
    kept.push(token)
  }
  return { kind: "ok", allow, answers, kept }
}
const runAgentWithKept = (kept: ReadonlyArray<string>, allow: ReadonlyArray<string>, answers: ReadonlyArray<QuestionAnswer>): OrcArgs => {
  if (kept.length === 2 && kept[0] === "--branch") {
    const name = kept[1] ?? ""
    if (name === "" || name.startsWith("--")) {
      return { kind: "UsageError", detail: "unexpected argument: --branch" }
    }
    return { kind: "RunAgent", taskFile: null, branch: name, allow, answers }
  }
  const taskFile = kept[0] ?? ""
  const flags = kept.slice(1)
  if (flags.length === 0) {
    return { kind: "RunAgent", taskFile, branch: undefined, allow, answers }
  }
  if (flags.length === 2 && flags[0] === "--branch") {
    const name = flags[1] ?? ""
    if (name === "" || name.startsWith("--")) {
      return { kind: "UsageError", detail: "unexpected argument: --branch" }
    }
    return { kind: "RunAgent", taskFile, branch: name, allow, answers }
  }
  const stray = flags[0] === "--branch" ? "--branch" : (flags[0] ?? "")
  return { kind: "UsageError", detail: `unexpected argument: ${stray}` }
}
const parseRunArgs = (rest: readonly string[]): OrcArgs => {
  if (rest.length === 0) {
    return { kind: "UsageError", detail: "orc run takes a task file" }
  }
  const split = splitRunArgs(rest)
  if (split.kind === "error") {
    return { kind: "UsageError", detail: split.detail }
  }
  return runAgentWithKept(split.kept, split.allow, split.answers)
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
