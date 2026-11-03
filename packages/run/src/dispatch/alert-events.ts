import { Effect, FileSystem, Result, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { BacklogError, platformFailure } from "./backlog-write"
import type { BeatAction } from "./beat-action"
import { recordEvent } from "./events"
import type { Command } from "./runner"

const QuotaPace = Schema.Struct({
  rule: Schema.Literal("quota-pace"),
  at: Schema.String,
  account: Schema.Struct({ title: Schema.String }),
  windowLabel: Schema.String,
  leftPoints: Schema.Finite,
  resetsAt: Schema.String
})
const HeavyLoad = Schema.Struct({
  rule: Schema.Literal("heavy-load"),
  at: Schema.String,
  machine: Schema.String,
  since: Schema.String,
  crossed: Schema.Array(Schema.String)
})
const LongTask = Schema.Struct({
  rule: Schema.Literal("long-task"),
  at: Schema.String,
  reason: Schema.Literals(["quiet", "total"]),
  machine: Schema.String,
  task: Schema.Struct({ id: Schema.String, title: Schema.String }),
  quietMinutes: Schema.Finite,
  totalMinutes: Schema.Finite
})
const Nightly = Schema.Struct({
  rule: Schema.Literal("nightly"),
  at: Schema.String,
  repo: Schema.String,
  workflow: Schema.String,
  runId: Schema.Finite,
  conclusion: Schema.String
})
const AlertLine = Schema.fromJsonString(Schema.Union([QuotaPace, HeavyLoad, LongTask, Nightly]))
type AlertLine = typeof AlertLine.Type

const minutesSpan = (minutes: number): string => {
  const whole = Math.round(minutes)
  if (whole < 60) {
    return String(whole) + "m"
  }
  if (whole < 24 * 60) {
    return String(Math.floor(whole / 60)) + "h " + String(whole % 60) + "m"
  }
  return String(Math.floor(whole / (24 * 60))) + "d " + String(Math.floor((whole % (24 * 60)) / 60)) + "h"
}

const alertText = (alert: AlertLine): string => {
  switch (alert.rule) {
    case "quota-pace": {
      return "alert: " + alert.account.title + "'s " + alert.windowLabel + " runs ahead of pace, " + String(alert.leftPoints) + " points left, resets at " + alert.resetsAt
    }
    case "heavy-load": {
      return "alert: " + alert.machine + " over its " + alert.crossed.join(" and ") + " limit since " + alert.since
    }
    case "long-task": {
      return "alert: " + alert.task.title + " (" + alert.task.id + ") on " + alert.machine +
        (alert.reason === "quiet" ? " quiet for " + minutesSpan(alert.quietMinutes) : " running for " + minutesSpan(alert.totalMinutes))
    }
    case "nightly": {
      return "alert: nightly " + alert.workflow + " of " + alert.repo + " run " + String(alert.runId) + " ended " + alert.conclusion
    }
  }
}

// The stream writes each fire once, as one line holding its rule, subject and time, so the line names the fire.
const fireKey = (rule: AlertLine["rule"], line: string): string =>
  "alert." + rule + "." + new Bun.CryptoHasher("sha256").update(line).digest("hex").slice(0, 16)

const alertsFile = (root: string): string => root + "/alerts.jsonl"
const pidFile = (root: string): string => root + "/alerts.pid"
const logFile = (root: string): string => root + "/logs/alerts.log"

// A line the stream is still writing has no newline yet, so only finished lines are read.
const finishedLines = (text: string): ReadonlyArray<string> => text.split("\n").slice(0, -1)

export const alertEvents = (root: string): Effect.Effect<ReadonlyArray<BeatAction>, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const file = alertsFile(root)
    const text = yield* fs.readFileString(file).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("")),
      Effect.mapError(platformFailure("read " + file))
    )
    const unread: Array<BeatAction> = []
    for (const [index, line] of finishedLines(text).entries()) {
      if (line.trim() === "") {
        continue
      }
      const alert = Schema.decodeResult(AlertLine)(line)
      if (Result.isFailure(alert)) {
        unread.push({ kind: "alert-unread", line: index + 1, reason: file + " holds no alert orc reads: " + alert.failure.message })
        continue
      }
      yield* recordEvent(root, { key: fireKey(alert.success.rule, line), at: alert.success.at, text: alertText(alert.success) })
    }
    return unread
  })

const alive = (pid: number): Effect.Effect<boolean> =>
  Effect.try({ try: () => process.kill(pid, 0), catch: () => new BacklogError({ detail: "no process " + String(pid) }) }).pipe(
    Effect.as(true),
    Effect.catchTag("BacklogError", () => Effect.succeed(false))
  )

// The stream leads its own session and is unreferenced, so it outlives the beat and keeps each rule's state between beats.
const startStream = (root: string, command: Command): Effect.Effect<number, BacklogError, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make("sh", ["-c", "exec \"$@\" >> \"$ORC_ALERTS\" 2>> \"$ORC_ALERTS_LOG\"", "orc-alerts", ...command], {
      env: { ORC_ALERTS: alertsFile(root), ORC_ALERTS_LOG: logFile(root) },
      extendEnv: true,
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore"
    }))
    yield* Effect.asVoid(handle.unref)
    return Number(handle.pid)
  }).pipe(Effect.scoped, Effect.mapError(platformFailure("start " + command.join(" "))))

export const watchAlerts = (
  root: string,
  command: Command
): Effect.Effect<ReadonlyArray<BeatAction>, BacklogError, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const file = pidFile(root)
    const written = yield* fs.readFileString(file).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("")),
      Effect.mapError(platformFailure("read " + file))
    )
    const pid = Number(written.trim())
    if (Number.isInteger(pid) && pid > 0 && (yield* alive(pid))) {
      return []
    }
    const started = yield* startStream(root, command)
    yield* fs.writeFileString(file, String(started)).pipe(Effect.mapError(platformFailure("write " + file)))
    return [{ kind: "alerts-started", command: command.join(" "), output: alertsFile(root) }]
  })
