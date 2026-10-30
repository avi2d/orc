import { Effect, Schema } from "effect";
import { recordLines } from "../decode";
import { TaskStateJson } from "./tasks";

const Count = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const Whole = Schema.Finite.check(Schema.isGreaterThan(0));

const Instant = Schema.DateTimeUtcFromString;

const SampledTask = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  project: Schema.String,
  state: TaskStateJson,
  // Lines written before the sampler kept the detail leave it out, so no stage can be read off them.
  detail: Schema.optionalKey(Schema.String),
  firstStartedAt: Instant,
  endedAt: Schema.NullOr(Instant),
});

// waitedChildSeconds holds the whole time of every child the process waited for, sampled or not.
const SampledProcess = Schema.Struct({
  identity: Schema.String,
  ownSeconds: Count,
  waitedChildSeconds: Schema.optionalKey(Count),
  parent: Schema.optionalKey(Schema.String),
});

const Usage = Schema.Struct({
  processes: Schema.Array(SampledProcess).check(Schema.isMinLength(1)),
  cpuCores: Count,
  residentBytes: Count,
});

const SampledFair = Schema.Struct({
  account: Schema.String,
  cycleSeconds: Schema.Finite,
  ratio: Schema.Finite,
  flagged: Schema.Boolean,
});

const SampledSpend = Schema.Struct({
  model: Schema.NullOr(Schema.String),
  tokens: Count,
  // A required field would drop the lines written before the sampler counted output tokens.
  outputTokens: Schema.NullOr(Count).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  fair: Schema.NullOr(SampledFair),
  provider: Schema.optionalKey(Schema.NullOr(Schema.Literals(["claude", "codex", "opencode-go"]))),
});

const SampledResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("success") }),
  Schema.Struct({ kind: Schema.Literal("exit"), code: Schema.Int }),
  Schema.Struct({ kind: Schema.Literal("spawn"), error: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("killed") }),
  Schema.Struct({ kind: Schema.Literal("errored") }),
  Schema.Struct({ kind: Schema.Literal("dependency") }),
]);

const runFields = {
  id: Schema.Int,
  command: Schema.String,
  path: Schema.String,
  startedAt: Instant,
};

const SampledTestRun = Schema.Union([
  Schema.Struct(runFields),
  Schema.Struct({ ...runFields, endedAt: Instant, result: SampledResult }),
]);

export const TaskSampleRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  at: Instant,
  machine: Schema.Struct({ cores: Whole, memoryBytes: Whole }),
  task: SampledTask,
  usage: Schema.NullOr(Usage),
  spend: Schema.optional(Schema.NullOr(SampledSpend)),
  tests: Schema.optional(Schema.Array(SampledTestRun)),
  orcStage: Schema.optional(Schema.String),
  orcStageSince: Schema.optional(Instant),
});

export type TaskSampleRecord = typeof TaskSampleRecord.Type;

export type SampledTask = typeof SampledTask.Type;

export type TaskUsage = typeof Usage.Type;

export type SampledProcess = typeof SampledProcess.Type;

export type SampledSpend = typeof SampledSpend.Type;

export type SampledTestRun = typeof SampledTestRun.Type;

export const encodeTaskSample = (record: TaskSampleRecord): Effect.Effect<string, Schema.SchemaError> =>
  Effect.map(Schema.encodeEffect(TaskSampleRecord)(record), (encoded) => JSON.stringify(encoded));

export const taskSampleRecords: (text: string) => ReadonlyArray<TaskSampleRecord> = recordLines(TaskSampleRecord);
