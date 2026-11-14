import { Duration, Effect, FileSystem } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { type Command, ConfigError, type Machine, readDispatchConfig, throughFor } from "../../shared/config/index"
import { capture, RunnerError } from "../../shared/process/index"
import { decodeRunsJson, type MachineFailure, type RunsJsonDocument } from "./run-history-view"

type RunsJsonRow = RunsJsonDocument["runs"][number]

export interface OtherMachines {
  readonly runs: ReadonlyArray<RunsJsonRow>
  readonly machines: ReadonlyArray<MachineFailure>
}

type Reading =
  | { readonly kind: "answered"; readonly runs: ReadonlyArray<RunsJsonRow> }
  | { readonly kind: "failed"; readonly failure: MachineFailure }

const answerSeconds = 10
const answerWait = Duration.seconds(answerSeconds)

// Without --local the other machine reads its own dispatch machines and could reach this one back.
const localRunsOf = (through: Command): Command => [...through, "runs", "--json", "--local"]

const decodeAnswer = (command: Command, stdout: string): Effect.Effect<RunsJsonDocument, RunnerError> =>
  Effect.try({
    try: (): unknown => JSON.parse(stdout),
    catch: () => new RunnerError({ detail: command.join(" ") + " printed no JSON" })
  }).pipe(
    Effect.flatMap((value) =>
      decodeRunsJson(value).pipe(
        Effect.mapError((error) => new RunnerError({ detail: command.join(" ") + " printed JSON orc cannot read: " + error.message }))
      )
    )
  )

const answerOf = (command: Command): Effect.Effect<RunsJsonDocument, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  capture(command, null).pipe(
    Effect.flatMap((result) => {
      const printed = result.stderr.trim() !== "" ? result.stderr.trim() : result.stdout.trim()
      return result.exitCode === 0
        ? decodeAnswer(command, result.stdout)
        : Effect.fail(new RunnerError({ detail: command.join(" ") + " exited " + result.exitCode + ": " + printed }))
    })
  )

const readMachine = (name: string, through: Command): Effect.Effect<Reading, never, ChildProcessSpawner.ChildProcessSpawner> => {
  const command = localRunsOf(through)
  return answerOf(command).pipe(
    Effect.timeoutOrElse({
      duration: answerWait,
      orElse: () => Effect.fail(new RunnerError({ detail: command.join(" ") + " did not answer within " + answerSeconds + " seconds" }))
    }),
    Effect.map((document): Reading => ({ kind: "answered", runs: document.runs.map((run) => run.machine === null ? { ...run, machine: name } : run) })),
    Effect.catch((error) => Effect.succeed<Reading>({ kind: "failed", failure: { machine: name, error: error.detail } }))
  )
}

const readOtherMachines = (machines: ReadonlyArray<Machine>): Effect.Effect<OtherMachines, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.forEach(
    machines.flatMap((machine) => {
      const through = throughFor(machine)
      return through === null ? [] : [{ name: machine.name, through }]
    }),
    (reach) => readMachine(reach.name, reach.through),
    { concurrency: "unbounded" }
  ).pipe(
    Effect.map((readings) => ({
      runs: readings.flatMap((reading) => (reading.kind === "answered" ? reading.runs : [])),
      machines: readings.flatMap((reading) => (reading.kind === "failed" ? [reading.failure] : []))
    }))
  )

export const readOtherMachinesFrom = (dispatchFile: string): Effect.Effect<OtherMachines, ConfigError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const present = yield* fs.exists(dispatchFile).pipe(
      Effect.mapError(() => new ConfigError({ file: dispatchFile, detail: "cannot look for the file" }))
    )
    if (!present) {
      return { runs: [], machines: [] }
    }
    const config = yield* readDispatchConfig(dispatchFile)
    return yield* readOtherMachines(config.machines)
  })

export const withOtherMachines = (document: RunsJsonDocument, others: OtherMachines): RunsJsonDocument => ({
  ...document,
  runs: [...document.runs, ...others.runs],
  machines: [...others.machines]
})
