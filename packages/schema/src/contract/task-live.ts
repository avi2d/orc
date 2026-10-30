import { DateTime, Option, Schema } from "effect";
import { type Decoded, decoded, decodeJson, flatMapDecoded, rejected } from "../decode";
import { mapOutcome, type Outcome } from "../reading";
import type { CountedProcess, LiveProcess, ProcessSamples } from "../sources/task-processes";
import type { LiveTasks } from "../views/task-levels";
import { outcomeOf } from "./outcome";

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

const CountedProcessJson = Schema.Struct(countedFields);

const LiveProcessJson = Schema.Struct({
  ...countedFields,
  residentBytes: Count,
  folder: Schema.NullOr(Schema.String),
});

const ProcessSamplesJson = Schema.Struct({
  intervalSeconds: Whole,
  startPrecisionMillis: Whole,
  before: Schema.Array(CountedProcessJson),
  after: Schema.Array(LiveProcessJson),
});

const LiveTasksJson = Schema.Struct({
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

const countedJson = (process: CountedProcess): typeof CountedProcessJson.Type => ({ ...process });

const liveJson = (process: LiveProcess): typeof LiveProcessJson.Type => ({ ...process, folder: process.folder ?? null });

export const liveTasksReport = ({
  generatedAt,
  live,
}: {
  readonly generatedAt: DateTime.Utc;
  readonly live: Outcome<LiveTasks>;
}): LiveTasksReport => ({
  schemaVersion: 1,
  generatedAt: DateTime.formatIso(generatedAt),
  live: mapOutcome(live, (tasks): typeof LiveTasksJson.Type => ({
    samples: {
      intervalSeconds: tasks.samples.intervalSeconds,
      startPrecisionMillis: tasks.samples.startPrecisionMillis,
      before: tasks.samples.before.map(countedJson),
      after: tasks.samples.after.map(liveJson),
    },
    programs: [...tasks.programs].map(([pid, program]) => ({ pid, program })),
    memoryBytes: tasks.memoryBytes,
  })),
});

const samplesOf = (samples: typeof ProcessSamplesJson.Type): ProcessSamples => ({
  ...samples,
  after: samples.after.map((process) => ({ ...process, folder: process.folder ?? undefined })),
});

export const decodeLiveTasksReport = (stdout: string): Outcome<LiveTasks> => {
  const report = flatMapDecoded(decodeJson(LiveTasksReport)(stdout), (parsed) =>
    Option.match(DateTime.make(parsed.generatedAt), {
      onNone: (): Decoded<LiveTasksReport> => rejected("generatedAt is not an instant"),
      onSome: (): Decoded<LiveTasksReport> => decoded(parsed),
    }),
  );
  if (report.kind !== "ok") return report;
  const { live } = report.value;
  if (live.kind !== "ok") return live;
  const tasks = live.value;
  return {
    kind: "ok",
    value: {
      samples: samplesOf(tasks.samples),
      programs: new Map(tasks.programs.map(({ pid, program }) => [pid, program] as const)),
      memoryBytes: tasks.memoryBytes,
    },
  };
};
