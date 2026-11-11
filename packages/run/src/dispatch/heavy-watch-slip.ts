import { Effect, Option, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { capture } from "./runner-exec"

export interface SlipTask {
  readonly pid: number
  readonly command: string
}

const argvBase = (word: string): string => {
  const base = word.slice(word.lastIndexOf("/") + 1)
  return base.startsWith("-") ? base.slice(1) : base
}

interface PsRow {
  readonly ppid: number
  readonly args: string
}

const psRows = (ps: string): Map<number, PsRow> => {
  const rows = new Map<number, PsRow>()
  for (const line of ps.split("\n")) {
    const parts = line.trim().split(" ").filter((part) => part !== "")
    const pid = Number(parts[0] ?? "")
    const ppid = Number(parts[1] ?? "")
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || parts.length < 3) {
      continue
    }
    rows.set(pid, { ppid, args: parts.slice(2).join(" ") })
  }
  return rows
}

const pueueNames: ReadonlySet<string> = new Set(["pueue", "pueued"])

const ownTree = (rows: ReadonlyMap<number, PsRow>, selfPids: ReadonlySet<number>): Set<number> => {
  const excluded = new Set<number>()
  for (const pid of selfPids) {
    let current = pid
    while (current !== 0 && !excluded.has(current)) {
      excluded.add(current)
      const next = rows.get(current)?.ppid
      if (next === undefined) {
        break
      }
      current = next
    }
  }
  return excluded
}

const behindPueue = (rows: ReadonlyMap<number, PsRow>, pid: number): boolean => {
  const seen = new Set<number>()
  let current: number | undefined = rows.get(pid)?.ppid
  while (current !== undefined && current !== 0 && !seen.has(current)) {
    seen.add(current)
    const row = rows.get(current)
    if (row === undefined) {
      return false
    }
    const first = row.args.split(" ").filter((part) => part !== "")[0] ?? ""
    if (pueueNames.has(argvBase(first))) {
      return true
    }
    current = row.ppid
  }
  return false
}

const shellNames: ReadonlySet<string> = new Set(["sh", "bash", "dash", "zsh"])

const unwrapShell = (words: ReadonlyArray<string>): ReadonlyArray<string> => {
  const [first = "", second = "", ...rest] = words
  return shellNames.has(argvBase(first)) && second === "-c" ? rest : words
}

const unwrapWords = (words: ReadonlyArray<string>): ReadonlyArray<string> => {
  let rest = words
  const marker = rest.indexOf("orc-heavy-wait")
  if (marker !== -1) {
    rest = rest.slice(marker + 2)
  }
  if (rest[0] === "taskpolicy" && rest[1] === "-c" && rest[2] === "utility") {
    rest = rest.slice(3)
  }
  return unwrapShell(rest)
}

export const stripHeavyWrapper = (command: string): string =>
  unwrapWords(command.split(" ").filter((part) => part !== "")).join(" ")

export const normalizeTaskCommand = (command: string): string =>
  stripHeavyWrapper(command).replace(/["'\\]/g, "")

const toolMatch = (words: ReadonlyArray<string>, tools: ReadonlyArray<string>): { readonly word: string; readonly index: number } | null => {
  const first = argvBase(words[0] ?? "")
  if (tools.includes(first)) {
    return { word: words[0] ?? "", index: 0 }
  }
  if (first === "node" && words.length > 1 && tools.includes(argvBase(words[1] ?? ""))) {
    return { word: words[1] ?? "", index: 1 }
  }
  return null
}

const ancestorArgs = (rows: ReadonlyMap<number, PsRow>, pid: number): ReadonlyArray<string> => {
  const commands: Array<string> = []
  const seen = new Set<number>()
  let current = pid
  while (current !== 0 && !seen.has(current)) {
    seen.add(current)
    const row = rows.get(current)
    if (row === undefined) {
      break
    }
    commands.push(row.args)
    current = row.ppid
  }
  return commands
}

export interface SlipCandidate {
  readonly pid: number
  readonly command: string
  readonly script: string
  readonly args: ReadonlyArray<string>
}

export const slipCandidates = (
  ps: string,
  tools: ReadonlyArray<string>,
  selfPids: ReadonlySet<number>,
  binDir: string
): ReadonlyArray<SlipCandidate> => {
  const rows = psRows(ps)
  const excluded = ownTree(rows, selfPids)
  const found: Array<SlipCandidate> = []
  for (const [pid, row] of rows) {
    if (excluded.has(pid)) {
      continue
    }
    const words = row.args.split(" ").filter((part) => part !== "")
    const match = toolMatch(words, tools)
    if (match === null || match.word.includes(binDir)) {
      continue
    }
    found.push({ pid, command: row.args, script: binDir + "/" + argvBase(match.word), args: words.slice(match.index + 1) })
  }
  return found.sort((a, b) => a.pid - b.pid)
}

export const slipHeld = (ps: string, pid: number, running: ReadonlySet<string>): boolean => {
  const rows = psRows(ps)
  return behindPueue(rows, pid) &&
    ancestorArgs(rows, pid).some((args) => running.has(normalizeTaskCommand(args)))
}

export const classifyCalls = (
  candidates: ReadonlyArray<SlipCandidate>
): Effect.Effect<ReadonlyMap<number, boolean>, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.forEach(candidates, (candidate) =>
    capture([candidate.script, ...candidate.args], null, { HEAVY_CLASSIFY: "1" }).pipe(
      Effect.map((result) => [candidate.pid, result.exitCode !== 0 || result.stdout.trim().split(" ")[0] === "1"] as const),
      Effect.orElseSucceed(() => [candidate.pid, true] as const)
    )
  ).pipe(Effect.map((entries) => new Map(entries)))

const SlipFire = Schema.Struct({
  rule: Schema.Literal("heavy-slip"),
  at: Schema.String,
  machine: Schema.String,
  command: Schema.String
})
const decodeSlip = Schema.decodeUnknownOption(Schema.fromJsonString(SlipFire))

export const lastSlipByCommand = (text: string): Record<string, string | undefined> => {
  const last: Record<string, string | undefined> = {}
  for (const line of text.split("\n")) {
    Option.match(decodeSlip(line), {
      onNone: () => undefined,
      onSome: (fire) => {
        if ((last[fire.command] ?? "") < fire.at) {
          last[fire.command] = fire.at
        }
      }
    })
  }
  return last
}

export const slipLine = (machine: string, command: string, at: string): string =>
  JSON.stringify({ rule: "heavy-slip", at, machine, command })
