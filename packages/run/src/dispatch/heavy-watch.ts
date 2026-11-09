import { hostname } from "node:os"
import { Effect, FileSystem, Option, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { alertsFile } from "./events"
import { heavyBinDir } from "./heavy"
import { readHeavySettings } from "./heavy-setup"
import { standinTools } from "./heavy-standin"
import { PueueStatus, taskLabel } from "./pueue-status"
import { ensureGroup, type Command } from "./runner"
import { RunnerError } from "./runner-error"
import { capture, decodeJson, pueue } from "./runner-exec"

export const watchTtlMinutes = 10
const watchIntervalSeconds = watchTtlMinutes * 60

const WatchTask = Schema.Struct({
  id: Schema.Int,
  label: Schema.NullOr(Schema.String),
  command: Schema.String,
  created_at: Schema.String,
  group: Schema.String,
  priority: Schema.Int,
  status: Schema.Unknown
})
const WatchState = Schema.Struct({
  tasks: Schema.Record(Schema.String, WatchTask),
  groups: Schema.Record(Schema.String, Schema.Struct({ status: Schema.String, parallel_tasks: Schema.Int }))
})
type WatchState = typeof WatchState.Type

const AlertFire = Schema.Struct({
  rule: Schema.Union([Schema.Literal("heavy-load"), Schema.Literal("long-task")]),
  at: Schema.String,
  machine: Schema.String
})
const decodeFire = Schema.decodeUnknownOption(Schema.fromJsonString(AlertFire))

const BypassFire = Schema.Struct({ rule: Schema.Literal("heavy-bypass") })
const decodeBypass = Schema.decodeUnknownOption(Schema.fromJsonString(BypassFire))

export const countBypass = (text: string): number =>
  text.split("\n").filter((line) => line.trim() !== "" && Option.isSome(decodeBypass(line))).length

export const lastAlertByMachine = (text: string): Record<string, string> => {
  const last: Record<string, string> = {}
  for (const line of text.split("\n")) {
    Option.match(decodeFire(line), {
      onNone: () => undefined,
      onSome: (fire) => {
        if ((last[fire.machine] ?? "") < fire.at) {
          last[fire.machine] = fire.at
        }
      }
    })
  }
  return last
}

export const staleMachines = (
  machines: ReadonlyArray<string>,
  lastAlert: Readonly<Record<string, string | undefined>>,
  nowMs: number,
  ttlMinutes: number = watchTtlMinutes
): ReadonlyArray<string> =>
  machines.filter((machine) => {
    const at = lastAlert[machine]
    if (at === undefined) {
      return true
    }
    const seen = Date.parse(at)
    return Number.isNaN(seen) || nowMs - seen > ttlMinutes * 60_000
  })

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

const ownTree = (rows: Map<number, PsRow>, selfPids: ReadonlySet<number>): Set<number> => {
  const excluded = new Set<number>()
  for (const pid of selfPids) {
    let current: number | undefined = pid
    while (current !== undefined && current !== 0 && !excluded.has(current)) {
      excluded.add(current)
      current = rows.get(current)?.ppid
    }
  }
  return excluded
}

const behindPueue = (rows: Map<number, PsRow>, pid: number): boolean => {
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

const ancestorArgs = (rows: Map<number, PsRow>, pid: number): ReadonlyArray<string> => {
  const commands: Array<string> = []
  const seen = new Set<number>()
  let current: number | undefined = pid
  while (current !== undefined && current !== 0 && !seen.has(current)) {
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

const classifyCalls = (
  candidates: ReadonlyArray<SlipCandidate>
): Effect.Effect<ReadonlyMap<number, boolean>, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.forEach(candidates, (candidate) =>
    capture([candidate.script, ...candidate.args], null, { HEAVY_CLASSIFY: "1" }).pipe(
      Effect.map((result) => [candidate.pid, result.stdout.trim().split(" ")[0] === "1"] as const),
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

export const lastSlipByCommand = (text: string): Record<string, string> => {
  const last: Record<string, string> = {}
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

const slipLine = (machine: string, command: string, at: string): string =>
  JSON.stringify({ rule: "heavy-slip", at, machine, command })

export interface OldTask {
  readonly id: number
  readonly command: string
  readonly ageMinutes: number
}

const decodedStatus = (status: unknown): PueueStatus | null =>
  Option.match(Schema.decodeUnknownOption(PueueStatus)(status), { onNone: () => null, onSome: (decoded) => decoded })

export const oldRunningTasks = (
  state: WatchState,
  group: string,
  nowMs: number,
  ttlMinutes: number
): ReadonlyArray<OldTask> => {
  const old: Array<OldTask> = []
  for (const task of Object.values(state.tasks)) {
    if (task.group !== group) {
      continue
    }
    const status = decodedStatus(task.status)
    if (status === null || !("Running" in status)) {
      continue
    }
    const started = Date.parse(status.Running.start)
    if (Number.isNaN(started) || nowMs - started <= ttlMinutes * 60_000) {
      continue
    }
    if (task.priority === 0) {
      continue
    }
    old.push({ id: task.id, command: stripHeavyWrapper(task.command), ageMinutes: Math.floor((nowMs - started) / 60_000) })
  }
  return old.sort((a, b) => a.id - b.id)
}

const stallLine = (machine: string, task: OldTask, at: string): string =>
  JSON.stringify({
    rule: "long-task",
    at,
    reason: "total",
    machine,
    task: { id: "pueue-" + String(task.id), title: task.command },
    quietMinutes: 0,
    totalMinutes: task.ageMinutes
  })

const appendLines = (file: string, lines: ReadonlyArray<string>): Effect.Effect<void, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  lines.length === 0
    ? Effect.void
    : capture(["sh", "-c", "cat >> \"$1\"", "sh", file], lines.join("\n") + "\n").pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.void
          : Effect.fail(new RunnerError({ detail: "cannot append " + file + ": " + result.stderr.trim() }))
      )
    )

export interface WatchReport {
  readonly old: ReadonlyArray<OldTask>
  readonly alerts: ReadonlyArray<string>
  readonly slips: ReadonlyArray<string>
}

export const watchOnce = (home: string, nowMs: number = Date.now()): Effect.Effect<WatchReport, RunnerError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const settings = yield* readHeavySettings(home)
    const backlog = home + "/backlog"
    const machine = hostname()
    const fs = yield* FileSystem.FileSystem
    const fired = yield* fs.readFileString(alertsFile(backlog)).pipe(Effect.orElseSucceed(() => ""))
    const state = yield* pueue(["status", "--json"]).pipe(
      Effect.flatMap((text) => decodeJson(text, WatchState, "pueue status --json"))
    )
    const lastAlert = lastAlertByMachine(fired)
    const old = oldRunningTasks(state, settings.group, nowMs, watchTtlMinutes)
    const oldest = old.reduce<OldTask | null>((latest, task) => latest === null || task.ageMinutes > latest.ageMinutes ? task : latest, null)
    const firedRecently = staleMachines([machine], lastAlert, nowMs, watchTtlMinutes).length === 0
    const at = new Date(nowMs).toISOString()
    const stalls = oldest === null || firedRecently ? [] : [stallLine(machine, oldest, at)]
    const ps = yield* capture(["ps", "-eo", "pid,ppid,command"], null).pipe(
      Effect.map((result) => result.stdout),
      Effect.orElseSucceed(() => "")
    )
    const alive = Object.values(state.tasks).flatMap((task) => {
      if (task.group !== settings.group) {
        return []
      }
      const status = decodedStatus(task.status)
      return status !== null && "Running" in status ? [task.command] : []
    })
    const seenSlip = lastSlipByCommand(fired)
    const queued = new Set(alive.map(normalizeTaskCommand))
    const candidates = slipCandidates(ps, standinTools(settings.commands), new Set([process.pid]), heavyBinDir(home))
    const queuedByPid = yield* classifyCalls(candidates)
    const found = new Map<string, SlipTask>()
    for (const candidate of candidates) {
      if (queuedByPid.get(candidate.pid) !== true) {
        continue
      }
      if (slipHeld(ps, candidate.pid, queued)) {
        continue
      }
      if (!found.has(candidate.command)) {
        found.set(candidate.command, { pid: candidate.pid, command: candidate.command })
      }
    }
    const slips = [...found.values()].sort((a, b) => a.pid - b.pid).filter((slip) => {
      const last = seenSlip[slip.command]
      if (last === undefined) {
        return true
      }
      const firedAt = Date.parse(last)
      return Number.isNaN(firedAt) || nowMs - firedAt > watchTtlMinutes * 60_000
    })
    const slipAlerts = slips.map((slip) => slipLine(machine, slip.command, at))
    yield* appendLines(alertsFile(backlog), [...stalls, ...slipAlerts])
    return { old, alerts: [...stalls, ...slipAlerts], slips: slips.map((slip) => slip.command) }
  })

export const watchGroup = (home: string): string =>
  "orc-heavy-watch-" + new Bun.CryptoHasher("sha256").update(taskLabel(home, "heavy-watch")).digest("hex").slice(0, 12)

const watchLoop = "watch_log=$1; shift; while true; do \"$@\" >> \"$watch_log\" 2>&1 || exit \"$?\"; sleep " + String(watchIntervalSeconds) + "; done"

export const ensureHeavyWatch = (home: string, orc: Command): Effect.Effect<string | null, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const group = watchGroup(home)
    yield* ensureGroup(group, ["--parallel", "1"])
    const label = taskLabel(home, "heavy-watch")
    const state = yield* pueue(["status", "--json"]).pipe(
      Effect.flatMap((text) => decodeJson(text, WatchState, "pueue status --json"))
    )
    const held = Object.values(state.tasks).some((task) => {
      if (task.group !== group || task.label !== label) {
        return false
      }
      const status = decodedStatus(task.status)
      return status !== null && !("Done" in status)
    })
    if (held) {
      return null
    }
    const log = home + "/heavy/watch.log"
    const id = yield* pueue([
      "add", "--group", group, "--label", label, "--working-directory", home, "--print-task-id", "--escape", "--",
      "sh", "-c", watchLoop, "orc-heavy-watch", log, ...orc, "heavy", "watch-once"
    ])
    return "queued the heavy watch as pueue task " + id.trim() + " in group " + group
  })

interface HeavyCheckTask {
  readonly id: number
  readonly command: string
  readonly ageMinutes: number
}

export interface HeavyCheck {
  readonly group: string
  readonly parallel: number
  readonly running: ReadonlyArray<HeavyCheckTask>
  readonly queued: ReadonlyArray<HeavyCheckTask>
  readonly bypass: number
}

const taskAge = (iso: string, nowMs: number): number | null => {
  const seen = Date.parse(iso)
  return Number.isNaN(seen) ? null : Math.max(0, Math.floor((nowMs - seen) / 60_000))
}

export const checkHeavy = (home: string, nowMs: number = Date.now()): Effect.Effect<HeavyCheck, RunnerError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const settings = yield* readHeavySettings(home)
    const backlog = home + "/backlog"
    const fs = yield* FileSystem.FileSystem
    const fired = yield* fs.readFileString(alertsFile(backlog)).pipe(Effect.orElseSucceed(() => ""))
    const bypass = countBypass(fired)
    const state = yield* pueue(["status", "--json"]).pipe(
      Effect.mapError((error) => new RunnerError({ detail: "heavy check: pueue is unreachable: " + error.detail })),
      Effect.flatMap((text) => decodeJson(text, WatchState, "pueue status --json"))
    )
    if (!Object.hasOwn(state.groups, settings.group)) {
      return yield* new RunnerError({ detail: "heavy check: the " + settings.group + " group is missing, run orc heavy path to create it" })
    }
    const entry = state.groups[settings.group]
    const running: Array<HeavyCheckTask> = []
    const queued: Array<HeavyCheckTask> = []
    for (const task of Object.values(state.tasks)) {
      if (task.group !== settings.group) {
        continue
      }
      const status = decodedStatus(task.status)
      if (status !== null && "Running" in status) {
        const age = taskAge(status.Running.start, nowMs)
        if (age !== null) {
          running.push({ id: task.id, command: stripHeavyWrapper(task.command), ageMinutes: age })
        }
      } else if (status !== null && "Queued" in status) {
        const age = taskAge(task.created_at, nowMs)
        if (age !== null) {
          queued.push({ id: task.id, command: stripHeavyWrapper(task.command), ageMinutes: age })
        }
      }
    }
    running.sort((a, b) => a.id - b.id)
    queued.sort((a, b) => a.id - b.id)
    return { group: settings.group, parallel: entry.parallel_tasks, running, queued, bypass }
  })

export const formatCheck = (check: HeavyCheck): string => {
  const free = Math.max(0, check.parallel - check.running.length)
  const oldest = check.queued.reduce((max, task) => Math.max(max, task.ageMinutes), 0)
  const head = "heavy: " + String(check.parallel) + " slot" + (check.parallel === 1 ? "" : "s") + ", " +
    String(free) + " free, " + String(check.running.length) + " running, " + String(check.queued.length) + " queued" +
    (check.queued.length === 0 ? "" : ", oldest queued " + String(oldest) + "m") +
    ", " + String(check.bypass) + " bypass" + (check.bypass === 1 ? "" : "es")
  const lines = check.running.map((task) => "  running #" + String(task.id) + " " + String(task.ageMinutes) + "m " + task.command)
    .concat(check.queued.map((task) => "  queued #" + String(task.id) + " " + String(task.ageMinutes) + "m " + task.command))
  return [head, ...lines].join("\n")
}
