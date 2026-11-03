import { Result, Schema } from "effect"
import type { ChatEvent } from "./chat-event"

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
const lineKey = (kind: string, line: string): string =>
  "alert." + kind + "." + new Bun.CryptoHasher("sha256").update(line).digest("hex").slice(0, 16)

// A line the stream is still writing has no newline yet, so only finished lines are read.
const finishedLines = (text: string): ReadonlyArray<string> => text.split("\n").slice(0, -1)

const lineEvents = (file: string, text: string): ReadonlyArray<ChatEvent> =>
  finishedLines(text).flatMap((line, index): ReadonlyArray<ChatEvent> => {
    if (line.trim() === "") {
      return []
    }
    const alert = Schema.decodeResult(AlertLine)(line)
    if (Result.isFailure(alert)) {
      return [{ key: lineKey("unread", line), at: "", text: "orc cannot read alert line " + String(index + 1) + " of " + file + ": " + alert.failure.message }]
    }
    return [{ key: lineKey(alert.success.rule, line), at: alert.success.at, text: alertText(alert.success) }]
  })

export const alertFires = (file: string, text: string): ReadonlyArray<ChatEvent> =>
  [...new Map(lineEvents(file, text).map((event) => [event.key, event])).values()]
