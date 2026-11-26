import { Effect, type FileSystem, type Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { BacklogError, rewriteClosed, taskPr, type MergeRecord, type TaskFileError } from "../../entities/backlog/index"
import type { ConfigError } from "../../shared/config/index"
import type { MergeBasis, PullRequestView } from "../../entities/pull-request/index"
import { greenChecks } from "../../entities/pull-request/index"

export type MergeRequirements = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner

export type SendBackForFix = (words: string) => Effect.Effect<string, BacklogError | ConfigError | TaskFileError, MergeRequirements>

export interface Landing {
  readonly root: string
  readonly id: string
  readonly url: string
  readonly basis: MergeBasis
  readonly sendBack: SendBackForFix
  readonly progress: (message: string) => Effect.Effect<void>
}

export interface Approved {
  readonly head: string
  readonly green: ReadonlyArray<string>
}

export const approvedAt = (view: PullRequestView): Approved => ({ head: view.headRefOid, green: greenChecks(view) })

export const writeMergeRecord = (landing: Landing, merge: MergeRecord | null): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  rewriteClosed<void>(landing.root, landing.id, (record) => {
    if (taskPr(record) !== landing.url) {
      return Effect.fail(new BacklogError({ detail: landing.id + " changed while orc merge was running" }))
    }
    if (merge === null && record.merge === undefined) {
      return Effect.succeed({ kind: "keep", result: undefined })
    }
    const { merge: _earlier, ...rest } = record
    return Effect.succeed({ kind: "write", record: merge === null ? rest : { ...rest, merge }, result: undefined })
  }).pipe(
    Effect.catch((error) => landing.progress("orc merge could not record its stage in " + landing.id + ": " + ("file" in error ? error.file + ": " : "") + error.detail))
  )

export const recordStage = (landing: Landing, approved: Approved, stage: MergeRecord["stage"], detail?: string): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  writeMergeRecord(landing, { basis: landing.basis, ...approved, stage, ...(detail === undefined ? {} : { detail }) })
