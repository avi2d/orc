import { Effect, FileSystem, Option, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { backlogPaths } from "./backlog"
import { readDispatchConfig } from "./config"
import { alertsFile } from "./events"
import { classifyHeavy } from "./heavy"
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

const quotedToken = (command: string, start: number, quote: string): { readonly text: string; readonly next: number } => {
  let text = ""
  let index = start
  while (index < command.length) {
    const char = command[index] ?? ""
    if (char === quote) {
      return { text, next: index + 1 }
    }
    if (char === "\\" && quote === "\"" && index + 1 < command.length) {
      text += command[index + 1] ?? ""
      index += 2
      continue
    }
    text += char
    index += 1
  }
  return { text, next: index }
}

export const splitCommand = (command: string): ReadonlyArray<string> => {
  const tokens: Array<string> = []
  let current = ""
  let index = 0
  while (index < command.length) {
    const char = command[index] ?? ""
    if (char === "'" || char === '"') {
      const quoted = quotedToken(command, index + 1, char)
      current += quoted.text
      index = quoted.next
      continue
    }
    if (char === " " || char === "\t") {
      if (current !== "") {
        tokens.push(current)
        current = ""
      }
      index += 1
      continue
    }
    current += char
    index += 1
  }
  if (current !== "") {
    tokens.push(current)
  }
  return tokens
}

const toolToken = (tokens: ReadonlyArray<string>, tools: ReadonlyArray<string>): { readonly tool: string; readonly args: ReadonlyArray<string> } | null => {
  for (let index = 0; index < tokens.length; index += 1) {
    const word = tokens[index] ?? ""
    const base = word.slice(word.lastIndexOf("/") + 1)
    if (tools.includes(base)) {
      return { tool: base, args: tokens.slice(index + 1) }
    }
  }
  return null
}

export const isWholeSuite = (command: string, extra: ReadonlyArray<string>, tools: ReadonlyArray<string>): boolean => {
  const found = toolToken(splitCommand(command), tools)
  if (found === null) {
    return false
  }
  const classified = classifyHeavy(found.tool, found.args, extra)
  return classified.queue && classified.priority === 0
}

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
  ttlMinutes: number,
  extra: ReadonlyArray<string>,
  tools: ReadonlyArray<string>
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
    if (isWholeSuite(task.command, extra, tools)) {
      continue
    }
    old.push({ id: task.id, command: task.command, ageMinutes: Math.floor((nowMs - started) / 60_000) })
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
  readonly stale: ReadonlyArray<string>
  readonly old: ReadonlyArray<OldTask>
  readonly alerts: ReadonlyArray<string>
}

export const watchOnce = (home: string, nowMs: number = Date.now()): Effect.Effect<WatchReport, RunnerError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const settings = yield* readHeavySettings(home)
    const backlog = home + "/backlog"
    const dispatch = yield* readDispatchConfig(backlogPaths(backlog).dispatchConfig).pipe(
      Effect.mapError((error) => new RunnerError({ detail: error.file + ": " + error.detail }))
    )
    const fs = yield* FileSystem.FileSystem
    const fired = yield* fs.readFileString(alertsFile(backlog)).pipe(Effect.orElseSucceed(() => ""))
    const state = yield* pueue(["status", "--json"]).pipe(
      Effect.flatMap((text) => decodeJson(text, WatchState, "pueue status --json"))
    )
    const tools = standinTools(settings.commands)
    const stale = staleMachines(dispatch.machines.map((machine) => machine.name), lastAlertByMachine(fired), nowMs, watchTtlMinutes)
    const old = oldRunningTasks(state, settings.group, nowMs, watchTtlMinutes, settings.commands, tools)
    const oldest = old.reduce<OldTask | null>((latest, task) => latest === null || task.ageMinutes > latest.ageMinutes ? task : latest, null)
    const at = new Date(nowMs).toISOString()
    const alerts = oldest === null ? [] : stale.map((machine) => stallLine(machine, oldest, at))
    yield* appendLines(alertsFile(backlog), alerts)
    return { stale, old, alerts }
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
}

const taskAge = (iso: string, nowMs: number): number | null => {
  const seen = Date.parse(iso)
  return Number.isNaN(seen) ? null : Math.max(0, Math.floor((nowMs - seen) / 60_000))
}

export const checkHeavy = (home: string, nowMs: number = Date.now()): Effect.Effect<HeavyCheck, RunnerError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const settings = yield* readHeavySettings(home)
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
          running.push({ id: task.id, command: task.command, ageMinutes: age })
        }
      } else if (status !== null && "Queued" in status) {
        const age = taskAge(task.created_at, nowMs)
        if (age !== null) {
          queued.push({ id: task.id, command: task.command, ageMinutes: age })
        }
      }
    }
    running.sort((a, b) => a.id - b.id)
    queued.sort((a, b) => a.id - b.id)
    return { group: settings.group, parallel: entry.parallel_tasks, running, queued }
  })

export const formatCheck = (check: HeavyCheck): string => {
  const free = Math.max(0, check.parallel - check.running.length)
  const oldest = check.queued.reduce((max, task) => Math.max(max, task.ageMinutes), 0)
  const head = "heavy: " + String(check.parallel) + " slot" + (check.parallel === 1 ? "" : "s") + ", " +
    String(free) + " free, " + String(check.running.length) + " running, " + String(check.queued.length) + " queued" +
    (check.queued.length === 0 ? "" : ", oldest queued " + String(oldest) + "m")
  const lines = check.running.map((task) => "  running #" + String(task.id) + " " + String(task.ageMinutes) + "m " + task.command)
    .concat(check.queued.map((task) => "  queued #" + String(task.id) + " " + String(task.ageMinutes) + "m " + task.command))
  return [head, ...lines].join("\n")
}
