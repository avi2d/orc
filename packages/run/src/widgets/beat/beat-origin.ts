import { Effect, type FileSystem } from "effect"
import { BacklogError, backlogPaths, findTask, type Parked, type Rewrite, rewriteNew, type TaskFileError, type TaskRecord } from "../../entities/backlog/index"
import type { RunnerRequirements } from "../../features/queueing-a-task/index"
import { type ConfigError, readDispatchConfig } from "../../shared/config/index"
import { otherRun, type ReadTaskRun, readTaskRun } from "./beat-resume"

export type RecordOrigin = {
  readonly kind: "RecordOrigin"
  readonly id: string
  readonly machine: string
  readonly run: string
}

type OriginGap = { readonly kind: "open"; readonly parked: Parked } | { readonly kind: "refused"; readonly detail: string }

const originGap = (id: string, record: TaskRecord): OriginGap => {
  if (record.state.kind !== "new") {
    return { kind: "refused", detail: id + " is " + record.state.kind + ", and only a parked task takes an origin" }
  }
  if (record.parked === null) {
    return { kind: "refused", detail: id + " is not parked, so it has no origin to record" }
  }
  const origin = record.parked.origin
  if (origin !== undefined) {
    return { kind: "refused", detail: id + " already resumes run " + origin.run + " on " + origin.machine }
  }
  return { kind: "open", parked: record.parked }
}

const writeOrigin = (args: RecordOrigin) => (fresh: TaskRecord): Effect.Effect<Rewrite<null>, BacklogError> => {
  const gap = originGap(args.id, fresh)
  if (gap.kind === "refused") {
    return Effect.fail(new BacklogError({ detail: gap.detail }))
  }
  return Effect.succeed({ kind: "write", record: { ...fresh, parked: { ...gap.parked, origin: { machine: args.machine, run: args.run } } }, result: null })
}

export const recordOrigin = (
  root: string,
  home: string,
  args: RecordOrigin,
  readRun: ReadTaskRun = readTaskRun
): Effect.Effect<string, BacklogError | ConfigError | TaskFileError, FileSystem.FileSystem | RunnerRequirements> =>
  Effect.gen(function*() {
    const config = yield* readDispatchConfig(backlogPaths(root).dispatchConfig)
    const machine = config.machines.find((candidate) => candidate.name === args.machine)
    if (machine === undefined) {
      return yield* new BacklogError({ detail: "the machine " + args.machine + " is not in dispatch.json" })
    }
    const record = yield* findTask(root, args.id)
    const gap = originGap(args.id, record)
    if (gap.kind === "refused") {
      return yield* new BacklogError({ detail: gap.detail })
    }
    const other = otherRun(yield* readRun(record, home, machine), args.run)
    if (other !== null) {
      return yield* new BacklogError({ detail: "run " + args.run + " is not the run of " + args.id + " on " + args.machine + ": " + other })
    }
    yield* rewriteNew(root, args.id, writeOrigin(args))
    return "recorded run " + args.run + " on " + args.machine + " as the origin of " + args.id + ", so the beat resumes it there"
  })
