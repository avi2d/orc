import { loadavg } from "node:os"
import { Duration, Effect, type FileSystem } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import type { Machine } from "./config"
import { checkHeavy } from "./heavy-watch"
import { ownedBySweep, throughFor } from "./machine-reach"
import { refuse, type RunnerError } from "./runner"
import { capture } from "./runner-exec"

export type HeavyReading = { readonly kind: "read"; readonly queued: number; readonly bypassWeek: number } | { readonly kind: "unread"; readonly reason: string }

export type LoadReading = { readonly kind: "read"; readonly fiveMinute: number; readonly heavy: HeavyReading } | { readonly kind: "unread"; readonly reason: string }

type LoadRequirements = FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner

export type ReadLoad = (machine: Machine, home: string) => Effect.Effect<LoadReading, never, LoadRequirements>

const fiveMinuteLoad = (): number => loadavg()[1] ?? 0

// A machine with this many heavy calls waiting takes no new start.
export const deepHeavyQueue = 3

const readHeavy = (home: string): Effect.Effect<HeavyReading, never, LoadRequirements> =>
  checkHeavy(home).pipe(
    Effect.map((check): HeavyReading => ({ kind: "read", queued: check.queued.length, bypassWeek: check.bypassWeek })),
    Effect.catchTag("RunnerError", (error) => Effect.succeed<HeavyReading>({ kind: "unread", reason: error.detail }))
  )

const heavyPattern = /^heavy queue: (\d+) queued, (\d+) bypass(?:es)? this week$/
const heavyUnreadPrefix = "heavy queue unread: "

const heavyLine = (heavy: HeavyReading): string =>
  heavy.kind === "unread"
    ? heavyUnreadPrefix + heavy.reason.replaceAll("\n", " ")
    : "heavy queue: " + String(heavy.queued) + " queued, " + String(heavy.bypassWeek) + " bypass" + (heavy.bypassWeek === 1 ? "" : "es") + " this week"

export const loadText = (fiveMinute: number, heavy: HeavyReading): string => String(fiveMinute) + "\n" + heavyLine(heavy)

export const runnerLoadText = (home: string): Effect.Effect<string, never, LoadRequirements> =>
  Effect.map(readHeavy(home), (heavy) => loadText(fiveMinuteLoad(), heavy))

const loadSeconds = 15

const loadPattern = /^\d+(\.\d+)?$/

const parseHeavy = (line: string | undefined, what: string): HeavyReading => {
  if (line === undefined) {
    return { kind: "unread", reason: what + " printed no heavy queue" }
  }
  if (line.startsWith(heavyUnreadPrefix)) {
    return { kind: "unread", reason: line.slice(heavyUnreadPrefix.length) }
  }
  const match = heavyPattern.exec(line)
  return match === null
    ? { kind: "unread", reason: what + " printed no heavy queue: " + line }
    : { kind: "read", queued: Number(match[1]), bypassWeek: Number(match[2]) }
}

export const parseLoad = (text: string, what: string): Effect.Effect<LoadReading, RunnerError> => {
  const [first = "", second] = text.trim().split("\n").map((line) => line.trim())
  return loadPattern.test(first)
    ? Effect.succeed({ kind: "read", fiveMinute: Number(first), heavy: parseHeavy(second, what) })
    : refuse(what + " printed no load: " + text.trim())
}

export const readMachineLoad: ReadLoad = (machine, home) => {
  const through = throughFor(machine)
  if (through === null) {
    return Effect.map(readHeavy(home), (heavy): LoadReading => ({ kind: "read", fiveMinute: fiveMinuteLoad(), heavy }))
  }
  const what = through.join(" ") + " runner load"
  return capture([...through, "runner", "load"], null).pipe(
    Effect.flatMap((result) => result.exitCode === 0 ? parseLoad(result.stdout, what) : refuse(what + " exited " + result.exitCode + ": " + result.stderr.trim())),
    Effect.catchTag("RunnerError", (error) => Effect.succeed<LoadReading>({ kind: "unread", reason: error.detail })),
    Effect.timeoutOrElse({ duration: Duration.seconds(loadSeconds), orElse: () => Effect.succeed<LoadReading>({ kind: "unread", reason: what + " timed out after " + loadSeconds + " seconds" }) })
  )
}

const loadWait = (machine: Machine, limit: number, reading: LoadReading): string | null => {
  if (reading.kind === "unread") {
    return "the load on " + machine.name + " is unread: " + reading.reason
  }
  return reading.fiveMinute > limit ? machine.name + "'s five-minute load is " + reading.fiveMinute + ", above its limit of " + limit : null
}

// A machine's heavy queue is made on its first run, so an unread queue cannot hold the start that would make it.
const heavyWait = (machine: Machine, reading: LoadReading): string | null =>
  reading.kind === "read" && reading.heavy.kind === "read" && reading.heavy.queued >= deepHeavyQueue
    ? machine.name + "'s heavy queue holds " + String(reading.heavy.queued) + " waiting calls, at or above its depth limit of " + String(deepHeavyQueue)
    : null

const machineWait = (machine: Machine, reading: LoadReading): string | null => {
  const limit = machine.loadLimit
  return (limit === undefined ? null : loadWait(machine, limit, reading)) ?? heavyWait(machine, reading)
}

// Only a machine started through orc runner start can be read, so another one is never held.
export const readOverloaded = (machines: ReadonlyArray<Machine>, home: string, readLoad: ReadLoad): Effect.Effect<ReadonlyMap<string, string>, never, LoadRequirements> =>
  Effect.forEach(machines, (machine) =>
    !ownedBySweep(machine)
      ? Effect.succeed([])
      : readLoad(machine, home).pipe(Effect.map((reading) => {
        const wait = machineWait(machine, reading)
        return wait === null ? [] : [[machine.name, wait] as const]
      })), { concurrency: "unbounded" }).pipe(Effect.map((entries) => new Map(entries.flat())))
