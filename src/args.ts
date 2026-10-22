import { askUserWord, questionWord } from "./no-mistakes"
export type OrcArgs =
  | { readonly kind: "PrintVersion" }
  | { readonly kind: "PrintHelp" }
  | { readonly kind: "ListRuns"; readonly json: boolean }
  | { readonly kind: "ShowRun"; readonly id: string; readonly json: boolean }
  | { readonly kind: "RunAgent"; readonly taskFile: string | null; readonly branch: string | undefined; readonly allow: ReadonlyArray<string> }
  | { readonly kind: "UsageError"; readonly detail: string }
const allowWords: ReadonlyArray<string> = [askUserWord, questionWord]

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

type AllowSplit =
  | { readonly kind: "ok"; readonly allow: ReadonlyArray<string>; readonly kept: ReadonlyArray<string> }
  | { readonly kind: "error"; readonly detail: string }
const readAllowWord = (word: string): string | null =>
  word === "" || word.startsWith("--") ? null : (allowWords.includes(word) ? word : null)
const splitAllowArgs = (rest: readonly string[]): AllowSplit => {
  const allow: Array<string> = []
  const kept: Array<string> = []
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? ""
    if (token !== "--allow") {
      kept.push(token)
      continue
    }
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
  }
  return { kind: "ok", allow, kept }
}
const runAgentWithKept = (kept: ReadonlyArray<string>, allow: ReadonlyArray<string>): OrcArgs => {
  if (kept.length === 2 && kept[0] === "--branch") {
    const name = kept[1] ?? ""
    if (name === "" || name.startsWith("--")) {
      return { kind: "UsageError", detail: "unexpected argument: --branch" }
    }
    return { kind: "RunAgent", taskFile: null, branch: name, allow }
  }
  const taskFile = kept[0] ?? ""
  const flags = kept.slice(1)
  if (flags.length === 0) {
    return { kind: "RunAgent", taskFile, branch: undefined, allow }
  }
  if (flags.length === 2 && flags[0] === "--branch") {
    const name = flags[1] ?? ""
    if (name === "" || name.startsWith("--")) {
      return { kind: "UsageError", detail: "unexpected argument: --branch" }
    }
    return { kind: "RunAgent", taskFile, branch: name, allow }
  }
  const stray = flags[0] === "--branch" ? "--branch" : (flags[0] ?? "")
  return { kind: "UsageError", detail: `unexpected argument: ${stray}` }
}
const parseRunArgs = (rest: readonly string[]): OrcArgs => {
  if (rest.length === 0) {
    return { kind: "UsageError", detail: "orc run takes a task file" }
  }
  const split = splitAllowArgs(rest)
  if (split.kind === "error") {
    return { kind: "UsageError", detail: split.detail }
  }
  return runAgentWithKept(split.kept, split.allow)
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
