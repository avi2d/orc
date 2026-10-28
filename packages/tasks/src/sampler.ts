import { type Config, Console, Data, DateTime, Duration, Effect, Option, Ref, Schedule } from "effect";
import {
  historyDays,
  type HostSources,
  LocalTasks,
  machineNames,
  type OwnedProcess,
  ownedProcesses,
  OrcMachines,
  PueueMachines,
  type PueueStatus,
  type Reading,
  readLocalResources,
  readQuotas,
  type ReportedTasks,
  resolvedOf,
  type SampledSpend,
  type SampledTask,
  type SampledTestRun,
  type Session,
  sessionQuotaOf,
  type SessionQuotaSources,
  type SessionQuotaView,
  type TaskEntry,
  TaskProcessesSource,
  type TaskSampleRecord,
  TaskSamplesSource,
  type TaskSpend,
  taskSpend,
  type TaskUsage,
  testsOf,
  zipOutcomes,
  inBackground,
} from "@tui-dash/schema";
import { orcStagesOf } from "./orc-stages";

export interface MachineFigures {
  readonly cores: number;
  readonly memoryBytes: number;
}

const sampledTaskOf = (task: Pick<TaskEntry, keyof SampledTask>): SampledTask => ({
  id: task.id,
  title: task.title,
  project: task.project,
  state: task.state,
  detail: task.detail,
  firstStartedAt: task.firstStartedAt,
  endedAt: task.endedAt,
});

// A source that failed to read leaves its map undefined, and each task keeps what its last line kept.
// The model name and the test runs join the signature, while the spend tokens ride along:
// tokens move every minute, so they would write every idle task every round.
export interface SampleDetail {
  readonly spend?: ReadonlyMap<string, SampledSpend> | undefined;
  readonly tests?: ReadonlyMap<string, ReadonlyArray<SampledTestRun>> | undefined;
  readonly orcStages?: ReadonlyMap<string, string> | undefined;
}

export interface WrittenLine {
  readonly signature: string;
  readonly spend: SampledSpend | null;
  readonly tests: ReadonlyArray<SampledTestRun>;
  readonly observed: boolean;
  readonly task: SampledTask;
  readonly spendAtMillis: number | undefined;
  readonly testsAtMillis: number | undefined;
  readonly orcStage: string | undefined;
  readonly orcStageSinceMillis: number | undefined;
  readonly orcStageAtMillis: number | undefined;
}

const signatureOf = (task: SampledTask, used: boolean, model: string | null, provider: string | null, tests: ReadonlyArray<SampledTestRun>, orcStage: string | undefined): string =>
  JSON.stringify([
    task.title,
    task.project,
    task.state,
    task.detail ?? null,
    DateTime.toEpochMillis(task.firstStartedAt),
    task.endedAt === null ? null : DateTime.toEpochMillis(task.endedAt),
    used,
    model,
    provider,
    tests,
    orcStage ?? null,
  ]);

const keyframeMillis = (historyDays * 86_400_000) / 2;

export const writtenOf = (records: ReadonlyArray<TaskSampleRecord>): ReadonlyMap<string, WrittenLine> => {
  const sorted = records.toSorted((left, right) => DateTime.toEpochMillis(left.at) - DateTime.toEpochMillis(right.at));
  const written = new Map<string, WrittenLine>();
  for (const [id, own] of Map.groupBy(sorted, (record) => record.task.id)) {
    const last = own.at(-1);
    if (last === undefined) continue;
    const carried = resolvedOf(own).at(-1);
    const spend = carried?.spend ?? null;
    const tests = carried?.tests ?? [];
    const spendAt = own.findLast((record) => record.spend !== undefined && record.spend !== null)?.at;
    const testsAt = own.findLast((record) => record.tests !== undefined && record.tests.length > 0)?.at;
    const staged = own.findLast((record) => record.orcStage !== undefined)?.orcStage;
    const stagedSince = own.findLast((record) => record.orcStageSince !== undefined)?.orcStageSince;
    const stagedAt = own.findLast((record) => record.orcStage !== undefined)?.at;
    const earliest = own.reduce((min, record) => (DateTime.toEpochMillis(record.task.firstStartedAt) < DateTime.toEpochMillis(min) ? record.task.firstStartedAt : min), last.task.firstStartedAt);
    const kept = last.task.firstStartedAt === earliest ? last.task : { ...last.task, firstStartedAt: earliest };
    written.set(id, {
      signature: signatureOf(kept, last.usage !== null, spend?.model ?? null, spend?.provider ?? null, tests, staged),
      spend,
      tests,
      observed: false,
      task: kept,
      spendAtMillis: spend === null || spendAt === undefined ? undefined : DateTime.toEpochMillis(spendAt),
      testsAtMillis: tests.length === 0 || testsAt === undefined ? undefined : DateTime.toEpochMillis(testsAt),
      orcStage: staged,
      orcStageSinceMillis: stagedSince === undefined ? undefined : DateTime.toEpochMillis(stagedSince),
      orcStageAtMillis: stagedAt === undefined ? undefined : DateTime.toEpochMillis(stagedAt),
    });
  }
  return written;
};

const spendEqual = (left: SampledSpend | null | undefined, right: SampledSpend | null | undefined): boolean =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const testsEqual = (left: ReadonlyArray<SampledTestRun> | undefined, right: ReadonlyArray<SampledTestRun> | undefined): boolean =>
  JSON.stringify(left ?? []) === JSON.stringify(right ?? []);

const usageOf = (owned: ReadonlyArray<OwnedProcess>): TaskUsage => ({
  processes: owned.map(({ identity, parent, ownSeconds, waitedChildSeconds }) => ({
    identity,
    ownSeconds,
    waitedChildSeconds,
    ...(parent === undefined ? {} : { parent }),
  })),
  cpuCores: owned.reduce((total, process) => total + process.cpuCores, 0),
  residentBytes: owned.reduce((total, process) => total + process.residentBytes, 0),
});

export interface Sampled {
  readonly records: ReadonlyArray<TaskSampleRecord>;
  readonly written: ReadonlyMap<string, WrittenLine>;
}

const spendDueOf = (spend: SampledSpend | null, previous: WrittenLine | undefined, atMillis: number): boolean =>
  spend !== null && (previous?.spendAtMillis === undefined || atMillis - previous.spendAtMillis >= keyframeMillis);

const testsDueOf = (tests: ReadonlyArray<SampledTestRun>, previous: WrittenLine | undefined, atMillis: number): boolean =>
  tests.length > 0 && (previous?.testsAtMillis === undefined || atMillis - previous.testsAtMillis >= keyframeMillis);

const stageDueOf = (staged: string | undefined, previous: WrittenLine | undefined, atMillis: number): boolean =>
  staged !== undefined && (previous?.orcStageAtMillis === undefined || atMillis - previous.orcStageAtMillis >= keyframeMillis);

const completedOf = (previous: WrittenLine | undefined, task: SampledTask): boolean => {
  if (previous !== undefined && (previous.task.state === "done" || previous.task.endedAt !== null)) return false;
  return task.state === "done" || task.endedAt !== null;
};

const writeSpendOf = (seen: SampledSpend | undefined, previous: WrittenLine | undefined, spend: SampledSpend | null, spendDue: boolean, completed: boolean): boolean => {
  if (spendDue) return true;
  if (completed && spend !== null) return true;
  return seen !== undefined && !spendEqual(seen, previous?.spend);
};

const writeTestsOf = (shown: ReadonlyArray<SampledTestRun> | undefined, previous: WrittenLine | undefined, tests: ReadonlyArray<SampledTestRun>, testsDue: boolean, completed: boolean): boolean => {
  if (testsDue && tests.length > 0) return true;
  if (completed && tests.length > 0) return true;
  return shown !== undefined && !testsEqual(shown, previous?.tests);
};

const unchangedOf = (mine: ReadonlyArray<OwnedProcess> | undefined, previous: WrittenLine | undefined, signature: string, spendDue: boolean, testsDue: boolean, stageDue: boolean): boolean => {
  if (mine !== undefined) return false;
  if (previous === undefined) return false;
  if (previous.signature !== signature) return false;
  return !spendDue && !testsDue && !stageDue;
};

interface ListedSample {
  readonly line: WrittenLine;
  readonly record: TaskSampleRecord | undefined;
}

interface ListedArgs {
  readonly task: SampledTask;
  readonly mine: ReadonlyArray<OwnedProcess> | undefined;
  readonly previous: WrittenLine | undefined;
  readonly spend: SampledSpend | null;
  readonly tests: ReadonlyArray<SampledTestRun>;
  readonly orcStage: string | undefined;
  readonly signature: string;
  readonly spendDue: boolean;
  readonly testsDue: boolean;
  readonly completed: boolean;
  readonly seen: SampledSpend | undefined;
  readonly shown: ReadonlyArray<SampledTestRun> | undefined;
  readonly at: DateTime.Utc;
  readonly machine: MachineFigures;
  readonly atMillis: number;
}

const sampleListed = (args: ListedArgs): ListedSample => {
  const { task, mine, previous, spend, tests, orcStage, signature, spendDue, testsDue, completed, seen, shown, at, machine, atMillis } = args;
  const stageDue = stageDueOf(orcStage, previous, atMillis);
  if (previous !== undefined && unchangedOf(mine, previous, signature, spendDue, testsDue, stageDue)) {
    return { line: { ...previous, task, observed: true }, record: undefined };
  }
  const writeSpend = writeSpendOf(seen, previous, spend, spendDue, completed);
  const writeTests = writeTestsOf(shown, previous, tests, testsDue, completed);
  const known = orcStage ?? previous?.orcStage;
  const sinceMillis = orcStage !== undefined && orcStage !== previous?.orcStage ? atMillis : previous?.orcStageSinceMillis;
  return {
    line: {
      signature,
      spend,
      tests,
      observed: true,
      task,
      spendAtMillis: writeSpend ? atMillis : previous?.spendAtMillis,
      testsAtMillis: writeTests ? atMillis : previous?.testsAtMillis,
      orcStage: known,
      orcStageSinceMillis: sinceMillis,
      orcStageAtMillis: known === undefined ? undefined : atMillis,
    },
    record: {
      schemaVersion: 1,
      at,
      machine,
      task,
      usage: mine === undefined ? null : usageOf(mine),
      ...(writeSpend ? { spend } : {}),
      ...(writeTests ? { tests } : {}),
      ...(known === undefined ? {} : { orcStage: known, orcStageSince: DateTime.makeUnsafe(sinceMillis ?? atMillis) }),
    },
  };
};

const terminalRecordOf = (previous: WrittenLine, at: DateTime.Utc, machine: MachineFigures): TaskSampleRecord | undefined => {
  if (!previous.observed) return undefined;
  if (previous.spend === null && previous.tests.length === 0) return undefined;
  return {
    schemaVersion: 1,
    at,
    machine,
    task: previous.task,
    usage: null,
    ...(previous.spend === null ? {} : { spend: previous.spend }),
    ...(previous.tests.length === 0 ? {} : { tests: previous.tests }),
  };
};

// A task with no live process adds a line only when its processes end or its signature changes, so an idle week does not fill the ledger.
export const sampleRecords = (
  tasks: ReadonlyArray<Pick<TaskEntry, keyof SampledTask>>,
  owned: ReadonlyArray<OwnedProcess>,
  detail: SampleDetail,
  machine: MachineFigures,
  at: DateTime.Utc,
  written: ReadonlyMap<string, WrittenLine>,
): Sampled => {
  const ownedByTask = Map.groupBy(owned, (process) => process.task);
  const next = new Map(written);
  const atMillis = DateTime.toEpochMillis(at);
  const seenIds = new Set(tasks.map((entry) => entry.id));
  const records: Array<TaskSampleRecord> = [];
  for (const entry of tasks) {
    const fresh = sampledTaskOf(entry);
    const previous = written.get(fresh.id);
    const task = previous !== undefined && DateTime.toEpochMillis(previous.task.firstStartedAt) < DateTime.toEpochMillis(fresh.firstStartedAt) ? { ...fresh, firstStartedAt: previous.task.firstStartedAt } : fresh;
    const mine = ownedByTask.get(task.id);
    const seen = detail.spend?.get(task.id);
    const shown = detail.tests?.get(task.id);
    const spend = seen ?? previous?.spend ?? null;
    const tests = shown ?? previous?.tests ?? [];
    const staged = detail.orcStages?.get(task.id);
    const signature = signatureOf(task, mine !== undefined, spend?.model ?? null, spend?.provider ?? null, tests, staged ?? previous?.orcStage);
    const sampled = sampleListed({ task, mine, previous, spend, tests, orcStage: staged, signature, spendDue: spendDueOf(spend, previous, atMillis), testsDue: testsDueOf(tests, previous, atMillis), completed: completedOf(previous, task), seen, shown, at, machine, atMillis });
    next.set(task.id, sampled.line);
    if (sampled.record !== undefined) records.push(sampled.record);
  }
  for (const [id, previous] of written) {
    if (seenIds.has(id)) continue;
    const record = terminalRecordOf(previous, at, machine);
    if (record === undefined) continue;
    next.delete(id);
    records.push(record);
  }
  return { records, written: next };
};

class SampleSkipped extends Data.TaggedError("SampleSkipped")<{ readonly reason: string }> {}

export type SamplerSources = LocalTasks | TaskProcessesSource | HostSources | TaskSamplesSource | PueueMachines | OrcMachines | SessionQuotaSources;

const readLocalQueue: Effect.Effect<Reading<PueueStatus> | undefined, Config.ConfigError, PueueMachines> = Effect.gen(function* () {
  const machines = yield* PueueMachines;
  const names = yield* machineNames;
  const local = machines.find((machine) => machine.name === names.local) ?? machines.at(0);
  if (local === undefined) return undefined;
  return yield* local.read;
});

const sampledSpendOf = (spend: TaskSpend): SampledSpend => ({
  model: spend.model ?? null,
  tokens: spend.tokens,
  outputTokens: spend.outputTokens ?? null,
  fair: spend.fair ?? null,
  provider: spend.provider ?? null,
});

// The levels join sessions the same way, so the sample keeps what the row showed.
const spendsOf = (reported: ReportedTasks, quota: SessionQuotaView, machine: string): ReadonlyMap<string, SampledSpend> => {
  const spends = taskSpend(quota, reported.view.tasks, (session: Session) => session.machine === undefined || session.machine === machine);
  return new Map([...spends].map(([id, spend]) => [id, sampledSpendOf(spend)] as const));
};

const detailOf = (
  reported: ReportedTasks,
  queue: Reading<PueueStatus> | undefined,
  quota: Option.Option<SessionQuotaView>,
  machine: string,
): SampleDetail => ({
  spend: Option.match(quota, { onNone: () => undefined, onSome: (view) => spendsOf(reported, view, machine) }),
  tests: queue?.kind === "ok" ? testsOf(reported.view.tasks, queue.value) : undefined,
});

interface Listing {
  readonly latest: Effect.Effect<Option.Option<Reading<ReportedTasks>>>;
  readonly lastListed: Ref.Ref<Option.Option<ReportedTasks>>;
}

const listedTasks = ({ latest, lastListed }: Listing): Effect.Effect<ReportedTasks, SampleSkipped> =>
  Effect.gen(function* () {
    const reading = yield* latest;
    if (Option.isSome(reading) && reading.value.kind === "ok") yield* Ref.set(lastListed, Option.some(reading.value.value));
    const listed = yield* Ref.get(lastListed);
    if (Option.isSome(reading) && reading.value.kind !== "ok") {
      const reason = reading.value.kind === "unreachable" ? reading.value.reason : reading.value.issue;
      if (Option.isNone(listed)) return yield* new SampleSkipped({ reason });
      yield* Console.error(`tui-dash-tasks: the tasks report failed, so this sample goes by the last one: ${reason}`);
    }
    if (Option.isNone(listed)) return yield* new SampleSkipped({ reason: "the tasks report has not answered yet" });
    return listed.value;
  });

const sampleRound = (
  written: Ref.Ref<ReadonlyMap<string, WrittenLine>>,
  listing: Listing,
  sessions: Effect.Effect<Option.Option<SessionQuotaView>, never, SessionQuotaSources>,
) =>
  Effect.gen(function* () {
    const processes = yield* TaskProcessesSource;
    const [reported, samples, view, queue, quota] = yield* Effect.all(
      [listedTasks(listing), processes.read, readLocalResources, readLocalQueue, sessions],
      { concurrency: "unbounded" },
    );
    const read = zipOutcomes(
      samples,
      zipOutcomes(view.machine.cpu, view.machine.memory, (cpu, memory) => ({ cores: cpu.cores, memoryBytes: memory.totalBytes })),
      (sampled, machine) => ({ sampled, machine }),
    );
    if (read.kind !== "ok") return yield* new SampleSkipped({ reason: read.kind === "unreachable" ? read.reason : read.issue });
    const { sampled, machine } = read.value;
    const at = yield* DateTime.now;
    const names = yield* machineNames;
    const detail = detailOf(reported, queue, quota, names.local);
    const round = sampleRecords(reported.view.tasks, ownedProcesses(reported.view.tasks, sampled), { ...detail, orcStages: yield* orcStagesOf(reported) }, machine, at, yield* Ref.get(written));
    const history = yield* TaskSamplesSource;
    yield* history.append(round.records);
    yield* Ref.set(written, round.written);
  });

const sampleEvery = Duration.minutes(1);

const readPatience = Duration.seconds(1);

// The tasks report and the session quota can each take most of a minute, and a sample waiting on either would leave gaps that break a
// 10 minute run, so both read in the background and each round goes by the last answer each gave.
export const runSampler: Effect.Effect<void, Config.ConfigError, SamplerSources> = Effect.scoped(
  Effect.gen(function* () {
    const local = yield* LocalTasks;
    if (Option.isNone(local)) {
      yield* Console.error("tui-dash-tasks: TUI_DASH_TASKS is unset, so there is no task to sample");
      process.exitCode = 1;
      return;
    }
    const read = yield* inBackground(() => local.value.read, readPatience);
    const listing: Listing = { latest: read(undefined), lastListed: yield* Ref.make(Option.none<ReportedTasks>()) };
    const sessions = yield* inBackground(() => sessionQuotaOf(readQuotas), readPatience);
    const history = yield* TaskSamplesSource;
    const written = yield* Ref.make(writtenOf(yield* history.read(yield* DateTime.now)));
    const round = sampleRound(written, listing, sessions(undefined)).pipe(
      Effect.catchTags({
        SampleSkipped: ({ reason }) => Console.error(`tui-dash-tasks: skipped a sample: ${reason}`),
        PlatformError: (error) => Console.error(`tui-dash-tasks: could not write the sample: ${error.message}`),
        SchemaError: (error) => Console.error(`tui-dash-tasks: could not write the sample: ${error.message}`),
      }),
    );
    yield* round.pipe(Effect.repeat(Schedule.fixed(sampleEvery)));
  }),
);
