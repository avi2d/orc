import { hostname } from "node:os"
import { Effect, FileSystem, Option, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { alertsFile } from "./events"
import { heavyBinDir } from "./heavy"
import { readHeavySettings } from "./heavy-setup"
import { standinTools } from "./heavy-standin"
import { PueueStatus, taskLabel } from "./pueue-status"
import { type Command, ensureGroup, capture, decodeJson, pueue } from "./runner-exec"
import { RunnerError } from "./runner-error"

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

const BypassFire = Schema.Struct({ rule: Schema.Literal("heavy-bypass"), at: Schema.optionalKey(Schema.String) })
const decodeBypass = Schema.decodeUnknownOption(Schema.fromJsonString(BypassFire))

const bypassTimes = (text: string): ReadonlyArray<number> =>
  text.split("\n").flatMap((line) =>
    line.trim() === "" ? [] : Option.match(decodeBypass(line), { onNone: () => [], onSome: (fire) => [Date.parse(fire.at ?? "")] })
  )

export const countBypass = (text: string): number => bypassTimes(text).length

const weekMs = 7 * 24 * 60 * 60_000

// A bypass with no readable time is counted in the total but never in a week it cannot be placed in.
export const countBypassWeek = (text: string, nowMs: number): number =>
  bypassTimes(text).filter((at) => !Number.isNaN(at) && at <= nowMs && nowMs - at <= weekMs).length

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
import {
  classifyCalls,
  lastSlipByCommand,
  normalizeTaskCommand,
  slipCandidates,
  slipHeld,
  slipLine,
  stripHeavyWrapper,
  type SlipCandidate,
  type SlipTask
} from "./heavy-watch-slip"

export { lastSlipByCommand, normalizeTaskCommand, slipCandidates, slipHeld, stripHeavyWrapper }

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

const stallForOldest = (old: ReadonlyArray<OldTask>, firedRecently: boolean, machine: string, at: string): ReadonlyArray<string> => {
  const oldest = old.reduce<OldTask | null>((latest, task) => latest === null || task.ageMinutes > latest.ageMinutes ? task : latest, null)
  return oldest === null || firedRecently ? [] : [stallLine(machine, oldest, at)]
}

const newSlipTasks = (
  candidates: ReadonlyArray<SlipCandidate>,
  queuedByPid: ReadonlyMap<number, boolean>,
  ps: string,
  queued: ReadonlySet<string>,
  seenSlip: Readonly<Record<string, string | undefined>>,
  nowMs: number
): ReadonlyArray<SlipTask> => {
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
  return [...found.values()].sort((a, b) => a.pid - b.pid).filter((slip) => {
    const last = seenSlip[slip.command]
    if (last === undefined) {
      return true
    }
    const firedAt = Date.parse(last)
    return Number.isNaN(firedAt) || nowMs - firedAt > watchTtlMinutes * 60_000
  })
}

export const watchOnce = (home: string, nowMs: number = Date.now()): Effect.Effect<WatchReport, RunnerError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const settings = yield* readHeavySettings(home)
    if (settings.through !== null) {
      return yield* new RunnerError({ detail: "heavy watch: the heavy calls queue through " + settings.through.join(" ") + ", which keeps no pueue group to watch" })
    }
    const backlog = home + "/backlog"
    const machine = hostname()
    const fs = yield* FileSystem.FileSystem
    const fired = yield* fs.readFileString(alertsFile(backlog)).pipe(Effect.orElseSucceed(() => ""))
    const state = yield* pueue(["status", "--json"]).pipe(
      Effect.flatMap((text) => decodeJson(text, WatchState, "pueue status --json"))
    )
    const lastAlert = lastAlertByMachine(fired)
    const old = oldRunningTasks(state, settings.group, nowMs, watchTtlMinutes)
    const firedRecently = staleMachines([machine], lastAlert, nowMs, watchTtlMinutes).length === 0
    const at = new Date(nowMs).toISOString()
    const stalls = stallForOldest(old, firedRecently, machine, at)
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
    const slips = newSlipTasks(candidates, queuedByPid, ps, queued, seenSlip, nowMs)
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
  readonly bypassWeek: number
}

const taskAge = (iso: string, nowMs: number): number | null => {
  const seen = Date.parse(iso)
  return Number.isNaN(seen) ? null : Math.max(0, Math.floor((nowMs - seen) / 60_000))
}

const checkPueueGroup = (home: string, group: string, nowMs: number): Effect.Effect<HeavyCheck, RunnerError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const backlog = home + "/backlog"
    const fs = yield* FileSystem.FileSystem
    const fired = yield* fs.readFileString(alertsFile(backlog)).pipe(Effect.orElseSucceed(() => ""))
    const bypass = countBypass(fired)
    const bypassWeek = countBypassWeek(fired, nowMs)
    const state = yield* pueue(["status", "--json"]).pipe(
      Effect.mapError((error) => new RunnerError({ detail: "heavy check: pueue is unreachable: " + error.detail })),
      Effect.flatMap((text) => decodeJson(text, WatchState, "pueue status --json"))
    )
    if (!Object.hasOwn(state.groups, group)) {
      return yield* new RunnerError({ detail: "heavy check: the " + group + " group is missing, run orc heavy path to create it" })
    }
    const entry = state.groups[group]
    const running: Array<HeavyCheckTask> = []
    const queued: Array<HeavyCheckTask> = []
    for (const task of Object.values(state.tasks)) {
      if (task.group !== group) {
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
    return { group, parallel: entry.parallel_tasks, running, queued, bypass, bypassWeek }
  })

export const checkHeavy = (home: string, nowMs: number = Date.now()): Effect.Effect<HeavyCheck, RunnerError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  readHeavySettings(home).pipe(
    Effect.flatMap((settings) =>
      settings.through === null
        ? checkPueueGroup(home, settings.group, nowMs)
        : Effect.fail(new RunnerError({ detail: "heavy check: the heavy calls queue through " + settings.through.join(" ") + ", which keeps no pueue group to read" }))
    )
  )

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
