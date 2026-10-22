export type OrcArgs =
  | { readonly kind: "PrintVersion" }
  | { readonly kind: "PrintHelp" }
  | { readonly kind: "ListRuns"; readonly json: boolean }
  | { readonly kind: "ShowRun"; readonly id: string; readonly json: boolean }
  | { readonly kind: "ScoreStep"; readonly runId: string; readonly step: string; readonly score: number; readonly note: string }
  | { readonly kind: "RunAgent"; readonly taskFile: string | null; readonly branch: string | undefined; readonly allow: boolean }
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

const parseRunArgs = (rest: readonly string[]): OrcArgs => {
  if (rest.length === 0) {
    return { kind: "UsageError", detail: "orc run takes a task file" }
  }
  const allow = rest.includes("--allow")
  const kept = rest.filter((flag) => flag !== "--allow")
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
