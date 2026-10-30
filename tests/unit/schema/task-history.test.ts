import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { DateTime, Effect, FileSystem, type PlatformError, type Schema } from "effect";
import {
  historyDays,
  keptCpuSeconds,
  type SampledProcess,
  type TaskHistory,
  type TaskSampleRecord,
  taskHistories,
  taskSampleRecords,
  taskSamplesAt,
  type TaskUsage,
} from "@tui-dash/schema";

const gib = 1024 ** 3;

const start = DateTime.makeUnsafe("2026-10-19T08:00:00Z");

const minutesAfter = (minutes: number): DateTime.Utc => DateTime.add(start, { minutes });

const machine = { cores: 16, memoryBytes: 47 * gib };

const task = { id: "harbor-bridge-plot", title: "Plot the bridge", project: "harbor", state: "working" as const, firstStartedAt: minutesAfter(-30), endedAt: null };

const running = (pid: number, ownSeconds: number, startTicks = 1000): SampledProcess => ({
  identity: "boot " + String(pid) + " " + String(startTicks),
  ownSeconds,
});

const ran = (...processes: ReadonlyArray<SampledProcess>): Partial<TaskUsage> => ({ processes });

const keptCpu = (history: TaskHistory | undefined): number => keptCpuSeconds(history?.processes ?? new Map());

const sample = (minutes: number, usage: Partial<TaskUsage> | null, overrides: Partial<TaskSampleRecord> = {}): TaskSampleRecord => ({
  schemaVersion: 1,
  at: minutesAfter(minutes),
  machine,
  task,
  usage: usage === null ? null : { processes: [running(100, 0)], cpuCores: 0, residentBytes: 0, ...usage },
  spend: null,
  tests: [],
  ...overrides,
});

const historyAt = (records: ReadonlyArray<TaskSampleRecord>, minutes: number) => taskHistories(records, minutesAfter(minutes), historyDays).get(task.id);

const everyMinute = (from: number, to: number, usage: Partial<TaskUsage>): ReadonlyArray<TaskSampleRecord> =>
  Array.from({ length: to - from + 1 }, (_, index) => sample(from + index, usage));

describe("taskHistories keeps the CPU a task used, per process, not the task-wide growth or a reused pid", () => {
  test("a process that exits keeps its last counter, and one that starts after it counts from its first reading", () => {
    const records = [sample(0, ran(running(100, 100))), sample(1, ran(running(100, 160))), sample(2, ran(running(200, 30))), sample(3, ran(running(200, 50)))];
    expect(keptCpu(historyAt(records, 3))).toBe(210);
  });

  test("a pid used again by a process that started later is another process", () => {
    const records = [sample(0, ran(running(100, 40))), sample(2, ran(running(100, 25, 7000)))];
    expect(keptCpu(historyAt(records, 2))).toBe(65);
  });

  test("a sample with no process between two keeps both processes' time", () => {
    const records = [sample(0, ran(running(100, 100))), sample(1, null), sample(2, ran(running(200, 40)))];
    expect(keptCpu(historyAt(records, 2))).toBe(140);
  });

  test("keeps the largest memory and the last sample's metadata", () => {
    const records = [
      sample(0, { residentBytes: 2 * gib }),
      sample(1, { residentBytes: 5 * gib }),
      sample(2, null, { task: { ...task, state: "done", endedAt: minutesAfter(2) } }),
    ];
    const history = historyAt(records, 5);
    expect(history?.peakBytes).toBe(5 * gib);
    expect(history?.task.state).toBe("done");
    expect(history?.lastSampledAt).toEqual(minutesAfter(2));
  });

  test("a task sampled with no process holds no memory or CPU figure", () => {
    const history = historyAt([sample(0, null), sample(1, null)], 1);
    expect(history?.peakBytes).toBeUndefined();
    expect(history?.processes.size).toBe(0);
  });
});

describe("taskHistories over a sampled child that ends, a waited child counted once and an ignored child's time kept", () => {
  const parent = (ownSeconds: number, waitedChildSeconds: number): SampledProcess => ({ ...running(100, ownSeconds), waitedChildSeconds });
  const child: SampledProcess = { ...running(200, 40), parent: running(100, 0).identity };
  const kept = (waited: number) => keptCpu(historyAt([sample(0, ran(parent(10, 0), child)), sample(1, ran(parent(12, waited)))], 1));

  test("counts once, in the parent that waited for it", () => {
    expect(kept(45)).toBe(57);
  });

  test("keeps its own sampled time when its parent ignores SIGCHLD", () => {
    expect(kept(0)).toBe(52);
  });
});

describe("taskHistories flags a task over the machine limits, never at exactly half the cores or a quarter of memory", () => {
  test("a task over half the cores in every sample across 10 minutes is over now", () => {
    expect(historyAt(everyMinute(0, 10, { cpuCores: 8.5 }), 10)?.episodes).toEqual([
      { limit: "cores", from: minutesAfter(0), to: minutesAfter(10), ongoing: true },
    ]);
  });

  test("9 minutes over half the cores is not yet a flag", () => {
    expect(historyAt(everyMinute(0, 9, { cpuCores: 8.5 }), 9)?.episodes).toEqual([]);
  });

  test("exactly half the cores is not over", () => {
    expect(historyAt(everyMinute(0, 20, { cpuCores: 8 }), 20)?.episodes).toEqual([]);
  });

  test("one sample under the limit breaks the run", () => {
    const records = [...everyMinute(0, 5, { cpuCores: 12 }), sample(6, { cpuCores: 2 }), ...everyMinute(7, 12, { cpuCores: 12 })];
    expect(historyAt(records, 12)?.episodes).toEqual([]);
  });

  test("a silence of more than two and a half minutes breaks the run", () => {
    const records = [...everyMinute(0, 5, { cpuCores: 12 }), ...everyMinute(9, 12, { cpuCores: 12 })];
    expect(historyAt(records, 12)?.episodes).toEqual([]);
  });

  test("a run that ended stays as an earlier episode", () => {
    const records = [...everyMinute(0, 10, { cpuCores: 12 }), ...everyMinute(11, 15, { cpuCores: 1 })];
    expect(historyAt(records, 15)?.episodes).toEqual([{ limit: "cores", from: minutesAfter(0), to: minutesAfter(10), ongoing: false }]);
  });

  test("a run whose sampler went quiet is no longer ongoing", () => {
    expect(historyAt(everyMinute(0, 10, { cpuCores: 12 }), 14)?.episodes.map(({ ongoing }) => ongoing)).toEqual([false]);
  });

  test("one sample over a quarter of memory is a flag, and exactly a quarter is not", () => {
    expect(historyAt([sample(0, { residentBytes: (47 * gib) / 4 })], 0)?.episodes).toEqual([]);
    expect(historyAt([sample(0, { residentBytes: (47 * gib) / 4 + 1 })], 0)?.episodes).toEqual([
      { limit: "memory", from: minutesAfter(0), to: minutesAfter(0), ongoing: true },
    ]);
  });

  test("a task that ended is never over now", () => {
    const ended = { ...task, state: "done" as const, endedAt: minutesAfter(10) };
    const records = everyMinute(0, 10, { cpuCores: 12 }).map((record) => ({ ...record, task: ended }));
    expect(historyAt(records, 10)?.episodes.map(({ ongoing }) => ongoing)).toEqual([false]);
  });
});

describe("taskHistories reads the last 7 days, excluding a sample from 7 days and a minute ago and one from the future", () => {
  test("leaves out a sample older than 7 days or later than now", () => {
    const now = minutesAfter(0);
    const records = [
      sample(-7 * 24 * 60 - 1, ran(running(100, 1000))),
      sample(-7 * 24 * 60, ran(running(200, 10))),
      sample(1, ran(running(300, 5000))),
    ];
    expect(keptCpu(taskHistories(records, now, historyDays).get(task.id))).toBe(10);
  });
});

describe("taskHistories over lines that carry detail only on change, keeping the model line and test runs of an earlier line", () => {
  const spend = { model: "opus", tokens: 1200, outputTokens: 300, fair: null };
  const testRun = { id: 7, command: "bun test", path: "/home/example/work/harbor", startedAt: minutesAfter(0) };

  test("resolves each line to its task's latest carrying line", () => {
    const records = [
      sample(0, { cpuCores: 8.5 }, { spend, tests: [testRun] }),
      sample(1, { cpuCores: 8.5 }, { spend: undefined, tests: undefined }),
      sample(2, null, { spend: undefined, tests: undefined }),
    ];
    const history = historyAt(records, 2);
    expect(history?.spend?.model).toBe("opus");
    expect(history?.tests.map((run) => run.command)).toEqual(["bun test"]);
    expect(history?.lastActiveAt).toEqual(minutesAfter(1));
  });

  test("an empty set on a later line does not clear the earlier one", () => {
    const records = [sample(0, { cpuCores: 8.5 }, { spend, tests: [testRun] }), sample(1, { cpuCores: 8.5 }, { tests: [] })];
    const history = historyAt(records, 1);
    expect(history?.tests.map((run) => run.command)).toEqual(["bun test"]);
  });

  test("an unchanged keyframe past its expired baseline is not activity", () => {
    const keyframed = { model: "opus", tokens: 1200, outputTokens: 300, fair: null };
    const records = [
      sample(0, { cpuCores: 0 }, {}),
      sample(1, { cpuCores: 0 }, {}),
      sample(2, { cpuCores: 0 }, { spend: keyframed }),
    ];
    expect(historyAt(records, 2)?.spend?.model).toBe("opus");
    expect(historyAt(records, 2)?.lastActiveAt).toEqual(minutesAfter(0));
  });

  test("spend tokens on a later line still mark the task active", () => {
    const records = [
      sample(0, { cpuCores: 0 }, { spend: { ...spend, tokens: 100 }, tests: [] }),
      sample(1, { cpuCores: 0 }, { spend: { ...spend, tokens: 200 } }),
    ];
    expect(historyAt(records, 1)?.lastActiveAt).toEqual(minutesAfter(1));
  });
});

const folders: Array<string> = [];

const scratch = (): string => {
  const folder = mkdtempSync(join(tmpdir(), "tui-dash-task-samples-"));
  folders.push(folder);
  return folder;
};

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const withSamples = <A>(directory: string, use: (samples: ReturnType<typeof taskSamplesAt>) => Effect.Effect<A, PlatformError.PlatformError | Schema.SchemaError>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* use(taskSamplesAt(fs, directory));
    }).pipe(Effect.provide(BunFileSystem.layer), Effect.orDie),
  );

describe("taskSamplesAt, one file a day kept for 7 days, and a torn line read past", () => {
  test("appends each record as one line of the day file and reads them back", async () => {
    const directory = scratch();
    const records = [sample(0, ran(running(100, 12))), { ...sample(0, null), task: { ...task, id: "harbor-inbox" } }];
    const read = await withSamples(directory, (samples) => Effect.andThen(samples.append(records), samples.read(minutesAfter(1))));
    expect(readdirSync(directory)).toEqual(["2026-10-19.jsonl"]);
    expect(readFileSync(join(directory, "2026-10-19.jsonl"), "utf8").split("\n")).toHaveLength(3);
    expect(read).toEqual(records);
  });

  test("skips a torn line and keeps reading", async () => {
    const directory = scratch();
    await withSamples(directory, (samples) => samples.append([sample(0, ran(running(100, 12)))]));
    writeFileSync(join(directory, "2026-10-19.jsonl"), '{"schemaVersion":1,"at":', { flag: "a" });
    expect(taskSampleRecords(readFileSync(join(directory, "2026-10-19.jsonl"), "utf8"))).toHaveLength(1);
    expect(await withSamples(directory, (samples) => samples.read(minutesAfter(1)))).toHaveLength(1);
  });

  test("reads no day file older than the span and its first day", async () => {
    const directory = scratch();
    await withSamples(directory, (samples) => samples.append([sample(0, ran(running(100, 12)))]));
    expect(await withSamples(directory, (samples) => samples.read(DateTime.makeUnsafe("2026-10-27T23:59:00Z")))).toHaveLength(1);
    expect(await withSamples(directory, (samples) => samples.read(DateTime.makeUnsafe("2026-10-28T00:00:00Z")))).toEqual([]);
  });

  test("removes the day files older than the span and its first day when a new day starts", async () => {
    const directory = scratch();
    for (const day of ["2026-10-10", "2026-10-11", "2026-10-12"]) writeFileSync(join(directory, `${day}.jsonl`), "");
    await withSamples(directory, (samples) => samples.append([sample(0, ran(running(100, 12)))]));
    expect(readdirSync(directory).toSorted()).toEqual(["2026-10-11.jsonl", "2026-10-12.jsonl", "2026-10-19.jsonl"]);
  });
});
