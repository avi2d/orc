import { Effect, FileSystem } from "effect"
import { BacklogError, type TaskFileError, type TaskRecord } from "../backlog/index"
import { originOfRun, parkedBranch, takenToNew } from "./taken-to-new"

export const retryStartedTask = (
  root: string,
  id: string,
  machine: string,
  run: string,
  at: string
): Effect.Effect<TaskRecord, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  takenToNew(root, id, "moved while orc read it", (record) =>
    record.state.kind !== "started" || record.state.claim.machine !== machine || record.retry !== undefined
      ? Effect.fail(new BacklogError({ detail: id + " is no longer eligible for retry" }))
      : Effect.succeed({
        ...record,
        retry: { run, at },
        parked: { ...record.parked, branch: parkedBranch(record, id), questions: record.parked?.questions ?? [], origin: originOfRun(record, machine, run), at },
        state: { kind: "new" }
      }))
