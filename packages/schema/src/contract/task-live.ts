import { Schema } from "effect";




import { outcomeOf } from "../shared/lib/outcome";

const Count = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const Whole = Schema.Finite.check(Schema.isGreaterThan(0));

const countedFields = {
  identity: Schema.String,
  pid: Count,
  parent: Count,
  startedAtMillis: Count,
  ownSeconds: Count,
  waitedChildSeconds: Count,
};

export const CountedProcessJson = Schema.Struct(countedFields);

export const LiveProcessJson = Schema.Struct({
  ...countedFields,
  residentBytes: Count,
  folder: Schema.NullOr(Schema.String),
});

export const ProcessSamplesJson = Schema.Struct({
  intervalSeconds: Whole,
  startPrecisionMillis: Whole,
  before: Schema.Array(CountedProcessJson),
  after: Schema.Array(LiveProcessJson),
});

export const LiveTasksJson = Schema.Struct({
  samples: ProcessSamplesJson,
  programs: Schema.Array(Schema.Struct({ pid: Count, program: Schema.String })),
  memoryBytes: Whole,
});

export const LiveTasksReport = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  generatedAt: Schema.String,
  live: outcomeOf(LiveTasksJson),
});

export type LiveTasksReport = typeof LiveTasksReport.Type;

