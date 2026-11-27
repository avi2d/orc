import { type Config, Console, Data, DateTime, Duration, Effect, Option, Ref, Schedule } from "effect";
import {
  inBackground,
  type HostSources,
  LocalTasks,
  machineNames,
  ownedProcesses,
  OrcMachines,
  PueueMachines,
  type PueueStatus,
  type Reading,
  readLocalResources,
  readQuotas,
  type ReportedTasks,
  type SampledSpend,
  type Session,
  sessionQuotaOf,
  type SessionQuotaSources,
  type SessionQuotaView,
  TaskProcessesSource,
  TaskSamplesSource,
  type TaskSpend,
  taskSpend,
  testsOf,
  zipOutcomes,
} from "@avi2dg/orc-schema";
import { orcStagesOf } from "./orc-stages";
import { type SampleDetail, sampleRecords, type WrittenLine, writtenOf } from "./sample-records";

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
      yield* Console.error(`orc-dash sample tasks: the tasks report failed, so this sample goes by the last one: ${reason}`);
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

// Waiting for a fresh report and quota would leave gaps in the sample history.
export const runSampler: Effect.Effect<void, Config.ConfigError, SamplerSources> = Effect.scoped(
  Effect.gen(function* () {
    const local = yield* LocalTasks;
    if (Option.isNone(local)) {
      yield* Console.error("orc-dash sample tasks: ORC_DASH_TASKS is unset, so there is no task to sample");
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
        SampleSkipped: ({ reason }) => Console.error(`orc-dash sample tasks: skipped a sample: ${reason}`),
        PlatformError: (error) => Console.error(`orc-dash sample tasks: could not write the sample: ${error.message}`),
        SchemaError: (error) => Console.error(`orc-dash sample tasks: could not write the sample: ${error.message}`),
      }),
    );
    yield* round.pipe(Effect.repeat(Schedule.fixed(sampleEvery)));
  }),
);
