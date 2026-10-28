import { DateTime } from "effect";
import type { SampledSpend, SampledTask, SampledTestRun, TaskSampleRecord } from "../contract/task-samples";
import { projectOf, type TestRun } from "./queues";
import { totalSecondsOf } from "./task-resources";
import type { TaskSpend } from "./task-spend";

export type MachineLimit = "cores" | "memory";

export interface LimitEpisode {
  readonly limit: MachineLimit;
  readonly from: DateTime.Utc;
  readonly to: DateTime.Utc;
  readonly ongoing: boolean;
}

export interface KeptProcess {
  readonly parent: string | undefined;
  readonly ownSeconds: number;
  readonly waitedChildSeconds: number;
  readonly sampledAtMillis: number;
}

export interface StageCue {
  readonly at: DateTime.Utc;
  readonly state: SampledTask["state"];
  readonly detail: string | undefined;
  readonly orcStage: string | undefined;
  readonly orcStageSince: DateTime.Utc | undefined;
}

export interface TaskHistory {
  readonly task: SampledTask;
  // Each cue opens where the state or the detail changed, oldest first.
  readonly cues: ReadonlyArray<StageCue>;
  readonly lastSampledAt: DateTime.Utc;
  readonly lastActiveAt: DateTime.Utc;
  readonly processes: ReadonlyMap<string, KeptProcess>;
  readonly peakBytes: number | undefined;
  readonly episodes: ReadonlyArray<LimitEpisode>;
  readonly spend: TaskSpend | undefined;
  readonly tests: ReadonlyArray<TestRun>;
}

const minuteMillis = 60_000;

const dayMillis = 86_400_000;

// The sampler writes every minute, so a longer silence means it missed samples and a run across it cannot be called unbroken.
const sampleGapMillis = 2.5 * minuteMillis;

const coresRunMillis = 10 * minuteMillis;

// The sampler writes a line for every live process, and an idle agent still ticks over, so a line alone is no activity.
const activeCores = 0.05;

const millis = DateTime.toEpochMillis;

const spanStartMillis = (now: DateTime.Utc, days: number): number => millis(now) - days * dayMillis;

const isOver = (limit: MachineLimit, record: TaskSampleRecord): boolean => {
  const usage = record.usage;
  if (usage === null) return false;
  return limit === "cores" ? usage.cpuCores > record.machine.cores / 2 : usage.residentBytes > record.machine.memoryBytes / 4;
};

const leastRunMillis: Record<MachineLimit, number> = { cores: coresRunMillis, memory: 0 };

interface Run {
  readonly from: TaskSampleRecord;
  readonly to: TaskSampleRecord;
}

const runsOver = (limit: MachineLimit, records: ReadonlyArray<TaskSampleRecord>): ReadonlyArray<Run> => {
  const runs: Array<Run> = [];
  let open: Run | undefined;
  for (const record of records) {
    const over = isOver(limit, record);
    if (open !== undefined && over && millis(record.at) - millis(open.to.at) <= sampleGapMillis) {
      open = { from: open.from, to: record };
      continue;
    }
    if (open !== undefined) runs.push(open);
    open = over ? { from: record, to: record } : undefined;
  }
  return open === undefined ? runs : [...runs, open];
};

const lastEpisode = (
  limit: MachineLimit,
  records: ReadonlyArray<TaskSampleRecord>,
  now: DateTime.Utc,
): ReadonlyArray<LimitEpisode> => {
  const last = records.at(-1);
  const run = runsOver(limit, records).findLast(({ from, to }) => millis(to.at) - millis(from.at) >= leastRunMillis[limit]);
  if (run === undefined || last === undefined) return [];
  const ongoing = run.to === last && last.task.endedAt === null && millis(now) - millis(last.at) <= sampleGapMillis;
  return [{ limit, from: run.from.at, to: run.to.at, ongoing }];
};

// A process that exits leaves the samples, so each process keeps its last counters rather than the task keeping a sum.
const keptProcessesOf = (records: ReadonlyArray<TaskSampleRecord>): ReadonlyMap<string, KeptProcess> =>
  new Map(
    records.flatMap((record) =>
      (record.usage?.processes ?? []).map((process) => {
        const kept: KeptProcess = {
          parent: process.parent,
          ownSeconds: process.ownSeconds,
          waitedChildSeconds: process.waitedChildSeconds ?? 0,
          sampledAtMillis: millis(record.at),
        };
        return [process.identity, kept] as const;
      }),
    ),
  );

// A child gone from its parent's later samples was waited for, so its time is in that parent's waited-child time too.
// A parent that ignores SIGCHLD reaps a child without taking its time, so what comes off stops at what the parent holds.
export const keptCpuSeconds = (processes: ReadonlyMap<string, KeptProcess>): number => {
  const reapedSeconds = new Map<string, number>();
  for (const process of processes.values()) {
    if (process.parent === undefined) continue;
    const parent = processes.get(process.parent);
    if (parent === undefined || parent.sampledAtMillis <= process.sampledAtMillis) continue;
    reapedSeconds.set(process.parent, (reapedSeconds.get(process.parent) ?? 0) + totalSecondsOf(process));
  }
  return [...processes].reduce(
    (total, [identity, process]) => total + process.ownSeconds + Math.max(0, process.waitedChildSeconds - (reapedSeconds.get(identity) ?? 0)),
    0,
  );
};

const spendOf = (sampled: SampledSpend | null): TaskSpend | undefined =>
  sampled === null
    ? undefined
    : { model: sampled.model ?? undefined, tokens: sampled.tokens, outputTokens: sampled.outputTokens ?? undefined, fair: sampled.fair ?? undefined, provider: sampled.provider ?? undefined };

const testOf = (run: SampledTestRun): TestRun =>
  "endedAt" in run
    ? { id: run.id, command: run.command, path: run.path, project: projectOf(run.path), startedAt: run.startedAt, endedAt: run.endedAt, result: run.result }
    : { id: run.id, command: run.command, path: run.path, project: projectOf(run.path), startedAt: run.startedAt };

export interface ResolvedDetail {
  readonly spend: SampledSpend | null;
  readonly tests: ReadonlyArray<SampledTestRun>;
}

// A line carries spend and tests only when they changed, so each line resolves to its task's latest carrying line.
// An unchanged line omits the set, so an empty one cannot clear it.
export const resolvedOf = (records: ReadonlyArray<TaskSampleRecord>): ReadonlyArray<ResolvedDetail> => {
  let spend: SampledSpend | null = null;
  let tests: ReadonlyArray<SampledTestRun> = [];
  return records.map((record) => {
    if (record.spend !== undefined) spend = record.spend;
    if (record.tests !== undefined && record.tests.length > 0) tests = record.tests;
    return { spend, tests };
  });
};

const isActive = (record: TaskSampleRecord, tokens: number | undefined, previous: number | undefined): boolean =>
  (record.usage?.cpuCores ?? 0) >= activeCores || (tokens !== undefined && previous !== undefined && tokens > previous);

const cuesOf = (records: ReadonlyArray<TaskSampleRecord>): ReadonlyArray<StageCue> => {
  const cues: Array<StageCue> = [];
  let staged: string | undefined;
  let stagedSince: DateTime.Utc | undefined;
  for (const { at, task, orcStage, orcStageSince } of records) {
    if (orcStage !== undefined && orcStage !== staged) {
      staged = orcStage;
      stagedSince = orcStageSince ?? at;
    } else if (orcStageSince !== undefined) stagedSince = orcStageSince;
    const last = cues.at(-1);
    if (last === undefined || last.state !== task.state || last.detail !== task.detail || last.orcStage !== staged)
      cues.push({ at, state: task.state, detail: task.detail, orcStage: staged, orcStageSince: stagedSince });
  }
  return cues;
};

const historyOf = (records: ReadonlyArray<TaskSampleRecord>, now: DateTime.Utc): TaskHistory | undefined => {
  const last = records.at(-1);
  if (last === undefined) return undefined;
  const peaks = records.flatMap((record) => (record.usage === null ? [] : [record.usage.residentBytes]));
  const detail = resolvedOf(records);
  const tokensAt = (index: number): number | undefined => detail[index]?.spend?.tokens;
  const carried = detail.at(-1) ?? { spend: null, tests: [] };
  const earliest = records.reduce((min, record) => (millis(record.task.firstStartedAt) < millis(min) ? record.task.firstStartedAt : min), last.task.firstStartedAt);
  return {
    task: last.task.firstStartedAt === earliest ? last.task : { ...last.task, firstStartedAt: earliest },
    cues: cuesOf(records),
    lastSampledAt: last.at,
    lastActiveAt:
      records.findLast((record, index) => isActive(record, tokensAt(index), index === 0 ? undefined : tokensAt(index - 1)))?.at ?? records[0].at,
    processes: keptProcessesOf(records),
    peakBytes: peaks.length === 0 ? undefined : Math.max(...peaks),
    episodes: [...lastEpisode("cores", records, now), ...lastEpisode("memory", records, now)],
    spend: spendOf(carried.spend),
    tests: carried.tests.map(testOf),
  };
};

export const taskHistories = (
  records: ReadonlyArray<TaskSampleRecord>,
  now: DateTime.Utc,
  days: number,
): ReadonlyMap<string, TaskHistory> => {
  const since = spanStartMillis(now, days);
  const kept = records
    .filter((record) => millis(record.at) >= since && millis(record.at) <= millis(now))
    .toSorted((left, right) => millis(left.at) - millis(right.at));
  const histories = new Map<string, TaskHistory>();
  for (const [id, own] of Map.groupBy(kept, (record) => record.task.id)) {
    const history = historyOf(own, now);
    if (history !== undefined) histories.set(id, history);
  }
  return histories;
};
