import { Schema } from "effect"

export const orcGroup = "orc"

export const PueueTask = Schema.Struct({
  id: Schema.Int,
  label: Schema.NullOr(Schema.String),
  group: Schema.String,
  path: Schema.String,
  status: Schema.Unknown
})
export type PueueTask = typeof PueueTask.Type

export const PueueState = Schema.Struct({ tasks: Schema.Record(Schema.String, PueueTask) })

export const PueueResult = Schema.Union([
  Schema.Literals(["Success", "Killed", "Errored", "DependencyFailed"]),
  Schema.Struct({ Failed: Schema.Int }),
  Schema.Struct({ FailedToSpawn: Schema.String })
])

export const PueueStatus = Schema.Union([
  Schema.Struct({ Done: Schema.Struct({ start: Schema.String, end: Schema.String, result: PueueResult }) }),
  Schema.Struct({ Running: Schema.Struct({ start: Schema.String }) }),
  Schema.Struct({ Paused: Schema.Struct({ start: Schema.String }) }),
  Schema.Struct({ Queued: Schema.Struct({}) }),
  Schema.Struct({ Stashed: Schema.Struct({}) }),
  Schema.Struct({ Locked: Schema.Struct({}) })
])
export type PueueStatus = typeof PueueStatus.Type

export const heldTask = (tasks: Readonly<Record<string, PueueTask>>, task: string): PueueTask | null => {
  let latest: PueueTask | null = null
  for (const candidate of Object.values(tasks)) {
    if (candidate.group === orcGroup && candidate.label === task && candidate.id > (latest?.id ?? -1)) {
      latest = candidate
    }
  }
  return latest
}
