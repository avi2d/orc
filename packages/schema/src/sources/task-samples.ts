import { Context, DateTime, Effect, FileSystem, Layer, type Config, type PlatformError, type Schema } from "effect";
import { encodeTaskSample, type TaskSampleRecord, taskSampleRecords } from "../contract/task-samples";
import { dayFileOf, dayFiles, expiredDayFiles } from "../sessions/capture";
import { dayFileReaderAt, prunedDayFiles } from "./capture-ledger";
import { taskSamplesDirectory } from "./environment";

export const historyDays = 7;

// The span starts partway through a day, and the day file holding its start must outlive that day.
const keptDays = historyDays + 1;

const keptDayFiles = (names: ReadonlyArray<string>, now: number): ReadonlyArray<string> => {
  const expired = new Set(expiredDayFiles(names, now, keptDays));
  return dayFiles(names).filter((name) => !expired.has(name));
};

export interface TaskSamples {
  readonly read: (now: DateTime.Utc) => Effect.Effect<ReadonlyArray<TaskSampleRecord>>;
  readonly append: (records: ReadonlyArray<TaskSampleRecord>) => Effect.Effect<void, PlatformError.PlatformError | Schema.SchemaError>;
}

export class TaskSamplesSource extends Context.Service<TaskSamplesSource, TaskSamples>()("tui-dash/TaskSamplesSource") {}

// One write of whole lines under O_APPEND lands whole beside a reader, which a rewrite of the file would race.
const appended =
  (fs: FileSystem.FileSystem, directory: string) =>
  (records: ReadonlyArray<TaskSampleRecord>): Effect.Effect<void, PlatformError.PlatformError | Schema.SchemaError> =>
    Effect.gen(function* () {
      const first = records.at(0);
      if (first === undefined) return;
      const at = DateTime.toEpochMillis(first.at);
      const day = dayFileOf(at);
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      const names = yield* fs.readDirectory(directory);
      const lines = yield* Effect.forEach(records, encodeTaskSample);
      yield* fs.writeFileString(`${directory}/${day}`, lines.map((line) => `${line}\n`).join(""), { flag: "a", mode: 0o600 });
      if (!names.includes(day)) yield* prunedDayFiles(fs, directory, expiredDayFiles(names, at, keptDays));
    });

export const taskSamplesAt = (fs: FileSystem.FileSystem, directory: string): TaskSamples => {
  const files = dayFileReaderAt(fs, directory, taskSampleRecords);
  return {
    read: (now) =>
      Effect.map(
        files((names) => keptDayFiles(names, DateTime.toEpochMillis(now))),
        (read) => read.flatMap((file) => file.records),
      ),
    append: appended(fs, directory),
  };
};

export const taskSamplesSourceLayer: Layer.Layer<TaskSamplesSource, Config.ConfigError, FileSystem.FileSystem> = Layer.effect(
  TaskSamplesSource,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return taskSamplesAt(fs, yield* taskSamplesDirectory);
  }),
);
