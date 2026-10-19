export type OrcArgs =
  | { readonly kind: "PrintVersion" }
  | { readonly kind: "PrintHelp" }
  | { readonly kind: "ListRuns"; readonly json: boolean }
  | { readonly kind: "RunAgent"; readonly taskFile: string; readonly branch: string | undefined }
  | { readonly kind: "UsageError"; readonly detail: string }

const parseRunArgs = (rest: readonly string[]): OrcArgs => {
  if (rest.length === 0) {
    return { kind: "UsageError", detail: "orc run takes a task file" }
  }
  const taskFile = rest[0]
  const flags = rest.slice(1)
  if (flags.length === 0) {
    return { kind: "RunAgent", taskFile, branch: undefined }
  }
  if (flags.length !== 2 || flags[0] !== "--branch") {
    return { kind: "UsageError", detail: `unexpected argument: ${flags[0]}` }
  }
  return { kind: "RunAgent", taskFile, branch: flags[1] }
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
