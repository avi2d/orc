import { Schema } from "effect";





import { outcomeOf } from "../../../shared/lib";

// In the order a run moves through them, so a later status is the more advanced one.
export const activeRunStatuses = ["requested", "pending", "waiting", "queued", "in_progress"] as const;

const Count = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

export const RunningJson = Schema.Struct({ id: Count, command: Schema.String, group: Schema.String, project: Schema.String, startedAt: Schema.String });

const ResultJson = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["success", "killed", "errored", "dependency"]) }),
  Schema.Struct({ kind: Schema.Literal("exit"), code: Schema.Finite }),
  Schema.Struct({ kind: Schema.Literal("spawn"), error: Schema.String }),
]);

export const EndedJson = Schema.Struct({ ...RunningJson.fields, endedAt: Schema.String, result: ResultJson });

const GroupJson = Schema.Struct({ name: Schema.String, status: Schema.Literals(["Running", "Paused", "Reset"]), parallel: Count });

export const PueueJson = Schema.Struct({
  running: Schema.Array(RunningJson),
  ended: Schema.Array(EndedJson),
  queued: Count,
  paused: Count,
  groups: Schema.Array(GroupJson),
});

export const RunJson = Schema.Struct({
  id: Count,
  title: Schema.String,
  workflow: Schema.String,
  status: Schema.Literals(activeRunStatuses),
  createdAt: Schema.String,
});

export const QueuesReport = Schema.Struct({
  machines: Schema.Array(Schema.Struct({ name: Schema.String, pueue: outcomeOf(PueueJson) })),
  actions: Schema.Struct({ repo: Schema.String, runs: outcomeOf(Schema.Array(RunJson)) }),
});

export type QueuesReport = typeof QueuesReport.Type;

