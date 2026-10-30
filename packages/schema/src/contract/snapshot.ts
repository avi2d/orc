import { Schema } from "effect";
import { ComposedSessionQuotaReport } from "./composed-session-quota";
import { outcomeOf } from "./outcome";
import { QueuesReport } from "./queues";
import { ResourcesReport } from "./resources";
import { TasksReport } from "./tasks";

export const snapshotSources = ["quota", "resources", "queues", "tasks"] as const;

export type SnapshotSource = (typeof snapshotSources)[number];

const FailedJson = Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String });

const answerOf = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Union([Schema.Struct({ status: Schema.Literal("ok"), ...fields }), FailedJson]);

const machinesOf = <S extends Schema.Top>(report: S) =>
  Schema.Array(Schema.Struct({ name: Schema.String, reading: outcomeOf(report) }));

const SourcesJson = Schema.Struct({
  quota: Schema.optionalKey(answerOf({ report: ComposedSessionQuotaReport })),
  resources: Schema.optionalKey(answerOf({ machines: machinesOf(ResourcesReport) })),
  queues: Schema.optionalKey(answerOf(QueuesReport.fields)),
  tasks: Schema.optionalKey(answerOf({ machines: machinesOf(TasksReport) })),
});

export const SnapshotReport = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  generatedAt: Schema.String,
  machine: Schema.String,
  sources: SourcesJson,
});

export type SnapshotReport = typeof SnapshotReport.Type;

export type SnapshotFields<K extends SnapshotSource> = Omit<Extract<NonNullable<SnapshotReport["sources"][K]>, { readonly status: "ok" }>, "status">;
