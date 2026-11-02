import { loadavg } from "node:os"
import { Duration, Effect } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import type { Machine } from "./config"
import { throughFor } from "./machine-reach"
import { capture, refuse, type RunnerError } from "./runner"

export type LoadReading = { readonly kind: "read"; readonly fiveMinute: number } | { readonly kind: "unread"; readonly reason: string }

export type ReadLoad = (machine: Machine) => Effect.Effect<LoadReading, never, ChildProcessSpawner.ChildProcessSpawner>

export const fiveMinuteLoad = (): number => loadavg()[1] ?? 0

const loadSeconds = 15

const loadPattern = /^\d+(\.\d+)?$/

const parseLoad = (text: string, what: string): Effect.Effect<number, RunnerError> =>
  loadPattern.test(text.trim()) ? Effect.succeed(Number(text.trim())) : refuse(what + " printed no load: " + text.trim())

export const readMachineLoad: ReadLoad = (machine) => {
  const through = throughFor(machine)
  if (through === null) {
    return Effect.sync(() => ({ kind: "read", fiveMinute: fiveMinuteLoad() }))
  }
  const what = through.join(" ") + " runner load"
  return capture([...through, "runner", "load"], null).pipe(
    Effect.flatMap((result) => result.exitCode === 0 ? parseLoad(result.stdout, what) : refuse(what + " exited " + result.exitCode + ": " + result.stderr.trim())),
    Effect.map((fiveMinute): LoadReading => ({ kind: "read", fiveMinute })),
    Effect.catchTag("RunnerError", (error) => Effect.succeed<LoadReading>({ kind: "unread", reason: error.detail })),
    Effect.timeoutOrElse({ duration: Duration.seconds(loadSeconds), orElse: () => Effect.succeed<LoadReading>({ kind: "unread", reason: what + " timed out after " + loadSeconds + " seconds" }) })
  )
}

export const loadWait = (machine: Machine, limit: number, reading: LoadReading): string | null => {
  if (reading.kind === "unread") {
    return "the load on " + machine.name + " is unread: " + reading.reason
  }
  return reading.fiveMinute > limit ? machine.name + "'s five-minute load is " + reading.fiveMinute + ", above its limit of " + limit : null
}
