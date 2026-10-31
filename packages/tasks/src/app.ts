import { type Config, Console, DateTime, Effect, Option, type Scope } from "effect";
import {
  type Freshness,
  historyDays,
  type HostSources,
  type Interval,
  type LiveTasks,
  LocalTasks,
  machineNames,
  NoMistakesMachines,
  type NoMistakesSnapshot,
  type OrcSnapshot,
  OrcMachines,
  type Outcome,
  type PipelineFolder,
  pipelineFoldersOf,
  PueueMachines,
  type PueueStatus,
  readLocalResources,
  type ReportedTasks,
  type ResourcesView,
  RemoteTaskHistory,
  type SessionQuotaView,
  TaskProcessesSource,
  type TaskListing,
  type TaskSampleRecord,
  TaskSamplesSource,
  taskLevels,
  TasksMachines,
  zipOutcomes,
  type ProcessSamples,
  type Reading,
  RemoteTaskLive,
  liveTasksReport,
  type BackgroundTuning,
  refreshingOf,
  type Stamped,
  stampedInBackground,
  stampedNow,
} from "@tui-dash/schema";
import type { TasksReadings } from "./layout";

export interface TaskPolls {
  readonly machine: string;
  readonly tasks: Effect.Effect<Stamped<TaskListing>>;
  readonly live: Effect.Effect<Option.Option<Stamped<Outcome<LiveTasks>>>>;
  readonly pueue: Effect.Effect<Option.Option<Stamped<Outcome<PueueStatus>>>>;
  readonly noMistakes: (folders: ReadonlyArray<PipelineFolder>) => Effect.Effect<Option.Option<Stamped<Outcome<NoMistakesSnapshot>>>>;
  readonly orc: (folders: ReadonlyArray<PipelineFolder>) => Effect.Effect<Option.Option<Stamped<Outcome<OrcSnapshot>>>>;
  // True while any poll runs, so the box shows reading only while it refreshes.
  readonly refreshing: Effect.Effect<boolean>;
  readonly listingsRefreshing: Effect.Effect<boolean>;
}

export interface RemotePolls extends TaskPolls {
  readonly liveConfigured: boolean;
  readonly samples: Effect.Effect<Option.Option<Stamped<ReadonlyArray<TaskSampleRecord>>>>;
}

export type TaskPollSources =
  | LocalTasks
  | TaskProcessesSource
  | HostSources
  | PueueMachines
  | NoMistakesMachines
  | OrcMachines
  | TasksMachines
  | RemoteTaskHistory
  | RemoteTaskLive;

const liveOf = (view: ResourcesView, samples: Outcome<ProcessSamples>): Outcome<LiveTasks> =>
  zipOutcomes(
    zipOutcomes(view.machine.memory, view.machine.processes, (memory, processes) => ({ memory, processes })),
    samples,
    ({ memory, processes }, sampled) => ({
      samples: sampled,
      programs: new Map(processes.map((process) => [process.pid, process.program])),
      memoryBytes: memory.totalBytes,
    }),
  );

const readLive = Effect.gen(function* () {
  const sampler = yield* TaskProcessesSource;
  const [view, samples] = yield* Effect.all([readLocalResources, sampler.read], { concurrency: "unbounded" });
  return liveOf(view, samples);
});

const readTaskLiveReport = Effect.gen(function* () {
  const live = yield* readLive;
  const generatedAt = yield* DateTime.now;
  return liveTasksReport({ generatedAt, live });
});

export const printTaskLiveJson: Effect.Effect<void, never, TaskProcessesSource | HostSources> = Effect.flatMap(
  readTaskLiveReport,
  (report) => Console.log(JSON.stringify(report)),
);

const unsetListing = stampedNow(Effect.succeed<TaskListing>({ kind: "unset" }));

const listingOf = (reading: Option.Option<Stamped<Reading<ReportedTasks>>>): Effect.Effect<Stamped<TaskListing>> =>
  Option.match(reading, { onNone: () => stampedNow(Effect.succeed<TaskListing>({ kind: "pending" })), onSome: Effect.succeed });

const machineOn = <M extends { readonly name: string }, R>(machines: Effect.Effect<ReadonlyArray<M>, never, R>, side: "local" | "remote") =>
  Effect.gen(function* () {
    const names = yield* machineNames;
    const list = yield* machines;
    return list.find((machine) => machine.name === (side === "local" ? names.local : names.remote));
  });

const localMachine = <M extends { readonly name: string }, R>(machines: Effect.Effect<ReadonlyArray<M>, never, R>) =>
  Effect.gen(function* () {
    const found = yield* machineOn(machines, "local");
    return found ?? (yield* machines).at(0);
  });

export const patience = "2 seconds";

// The orchestrator's report and the process samples can each take seconds, so each reads on its own fiber and the screen shows the last answer.
export const backgroundTaskPollsWithin = (
  tuning?: BackgroundTuning,
): Effect.Effect<TaskPolls, Config.ConfigError, TaskPollSources | Scope.Scope> =>
  Effect.gen(function* () {
    const wait = tuning?.patience ?? patience;
    const options = { revalidate: tuning?.revalidate };
    const names = yield* machineNames;
    const local = yield* LocalTasks;
    const pueue = yield* localMachine(PueueMachines);
    const mistakes = yield* localMachine(NoMistakesMachines);
    const orcs = yield* localMachine(OrcMachines);
    const services = yield* Effect.context<TaskProcessesSource | HostSources>();
    const tasks = Option.isSome(local) ? yield* stampedInBackground(() => local.value.read, wait, options) : undefined;
    const live = yield* stampedInBackground(() => Effect.provideContext(readLive, services), wait, options);
    const queue = pueue === undefined ? undefined : yield* stampedInBackground(() => pueue.read, wait, options);
    const mistakeReads = mistakes === undefined ? undefined : yield* stampedInBackground(mistakes.read, wait, options);
    const orcReads = orcs === undefined ? undefined : yield* stampedInBackground(orcs.read, wait, options);
    return {
      machine: names.local,
      tasks: tasks === undefined ? unsetListing : Effect.flatMap(tasks.read(undefined), listingOf),
      live: live.read(undefined),
      pueue: queue === undefined ? Effect.succeedNone : queue.read(undefined),
      noMistakes: (folders) => (mistakeReads === undefined ? Effect.succeedNone : mistakeReads.read(folders)),
      orc: (folders) => (orcReads === undefined ? Effect.succeedNone : orcReads.read(folders)),
      refreshing: refreshingOf([tasks, live, queue, mistakeReads, orcReads].flatMap((poll) => (poll === undefined ? [] : [poll]))),
      listingsRefreshing: tasks === undefined ? Effect.succeed(false) : tasks.refreshing,
    };
  });

export const backgroundTaskPolls: Effect.Effect<TaskPolls, Config.ConfigError, TaskPollSources | Scope.Scope> =
  backgroundTaskPollsWithin();

// The other machine keeps no samples here, so its report reads beside its history, and a history that fails or is unset leaves the report's tasks only.
const historySamples = (outcome: Outcome<ReadonlyArray<TaskSampleRecord>> | undefined): ReadonlyArray<TaskSampleRecord> =>
  outcome?.kind === "ok" ? outcome.value : [];

export type RemoteTaskPollSources = TasksMachines | PueueMachines | NoMistakesMachines | OrcMachines | RemoteTaskHistory | RemoteTaskLive;

// The live and the once-only remote polls start from the same entries, so one helper resolves the other machine's pieces.
const remotePieces = Effect.gen(function* () {
  const names = yield* machineNames;
  const machines = yield* TasksMachines;
  const remote = machines.find((machine) => machine.name === names.remote);
  if (remote === undefined) return undefined;
  const pueue = yield* machineOn(PueueMachines, "remote");
  const mistakes = yield* machineOn(NoMistakesMachines, "remote");
  const orcs = yield* machineOn(OrcMachines, "remote");
  const history = yield* RemoteTaskHistory;
  const live = yield* RemoteTaskLive;
  return { machine: names.remote, remote, pueue, mistakes, orcs, history, live };
});

export const backgroundRemoteTaskPollsWithin = (
  tuning?: BackgroundTuning,
): Effect.Effect<RemotePolls | undefined, Config.ConfigError, RemoteTaskPollSources | Scope.Scope> =>
  Effect.gen(function* () {
    const wait = tuning?.patience ?? patience;
    const options = { revalidate: tuning?.revalidate };
    const pieces = yield* remotePieces;
    if (pieces === undefined) return undefined;
    const { machine, remote, pueue, mistakes, orcs, history, live: liveMachine } = pieces;
    const tasks = yield* stampedInBackground(() => remote.read, wait, options);
    const queue = pueue === undefined ? undefined : yield* stampedInBackground(() => pueue.read, wait, options);
    const mistakeReads = mistakes === undefined ? undefined : yield* stampedInBackground(mistakes.read, wait, options);
    const orcReads = orcs === undefined ? undefined : yield* stampedInBackground(orcs.read, wait, options);
    const samples =
      Option.isSome(history)
        ? yield* stampedInBackground(() => Effect.map(history.value.read, historySamples), wait, options)
        : undefined;
    const live = Option.isSome(liveMachine) ? yield* stampedInBackground(() => liveMachine.value.read, wait, options) : undefined;
      return {
        machine,
        tasks: Effect.flatMap(tasks.read(undefined), listingOf),
        live: live === undefined ? Effect.succeedNone : live.read(undefined),
        liveConfigured: Option.isSome(liveMachine),
        pueue: queue === undefined ? Effect.succeedNone : queue.read(undefined),
        noMistakes: (folders) => (mistakeReads === undefined ? Effect.succeedNone : mistakeReads.read(folders)),
        orc: (folders) => (orcReads === undefined ? Effect.succeedNone : orcReads.read(folders)),
        samples: samples === undefined ? Effect.succeedNone : samples.read(undefined),
        refreshing: refreshingOf([tasks, live, queue, mistakeReads, orcReads, samples].flatMap((poll) => (poll === undefined ? [] : [poll]))),
        listingsRefreshing: tasks.refreshing,
      };
    });

export const backgroundRemoteTaskPolls: Effect.Effect<RemotePolls | undefined, Config.ConfigError, RemoteTaskPollSources | Scope.Scope> =
  backgroundRemoteTaskPollsWithin();

export interface TaskRead {
  readonly readings: TasksReadings;
  readonly listing: TaskListing;
  readonly pueue: Outcome<PueueStatus> | undefined;
  readonly freshness: ReadonlyArray<Freshness>;
}

const listedWithPipelines = (polls: Pick<TaskPolls, "tasks" | "noMistakes" | "orc">) =>
  Effect.gen(function* () {
    const stamped = yield* polls.tasks;
    const tasks = stamped.value;
    const reported = tasks.kind === "ok" ? tasks.value.view.tasks : [];
    const [mistakes, orcs] = yield* Effect.all(
      [polls.noMistakes(pipelineFoldersOf(reported, "full review fix")), polls.orc(pipelineFoldersOf(reported, "orc run"))],
      { concurrency: "unbounded" },
    );
    return {
      tasks,
      noMistakes: Option.flatMap(mistakes, (held) => Option.some(held.value)),
      noMistakesAt: Option.getOrUndefined(Option.map(mistakes, (held) => held.at)),
      orc: Option.flatMap(orcs, (held) => Option.some(held.value)),
      orcAt: Option.getOrUndefined(Option.map(orcs, (held) => held.at)),
    };
  });

const freshnessEntry = (at: number | undefined): ReadonlyArray<Freshness> => (at === undefined ? [] : [{ at, kind: "live" }]);

interface ListedPipelines {
  readonly tasks: TaskListing;
  readonly noMistakes: Option.Option<Outcome<NoMistakesSnapshot>>;
  readonly noMistakesAt: number | undefined;
  readonly orc: Option.Option<Outcome<OrcSnapshot>>;
  readonly orcAt: number | undefined;
}

const taskReadOf = (args: {
  readonly machine: string;
  readonly origin: "local" | "remote";
  readonly liveConfigured: boolean;
  readonly listed: ListedPipelines;
  readonly live: Option.Option<Stamped<Outcome<LiveTasks>>>;
  readonly queue: Option.Option<Stamped<Outcome<PueueStatus>>>;
  readonly samples: ReadonlyArray<TaskSampleRecord>;
  readonly sessions: SessionQuotaView | undefined;
  readonly now: DateTime.Utc;
  readonly zone: DateTime.TimeZone;
  readonly interval: Interval;
  readonly extraFreshness: ReadonlyArray<Freshness>;
}): TaskRead => {
  const pueue = Option.getOrUndefined(Option.flatMap(args.queue, (held) => Option.some(held.value)));
  const freshness: ReadonlyArray<Freshness> = [
    ...freshnessEntry(Option.getOrUndefined(Option.map(args.live, (held) => held.at))),
    ...freshnessEntry(Option.getOrUndefined(Option.map(args.queue, (held) => held.at))),
    ...freshnessEntry(args.listed.noMistakesAt),
    ...freshnessEntry(args.listed.orcAt),
    ...args.extraFreshness,
  ];
  return {
    readings: {
      levels: taskLevels({
        machine: args.machine,
        origin: args.origin,
        zone: args.zone,
        tasks: args.listed.tasks,
        samples: args.samples,
        live: Option.getOrUndefined(Option.map(args.live, (held) => held.value)),
        liveConfigured: args.liveConfigured,
        pueue,
        noMistakes: Option.getOrUndefined(args.listed.noMistakes),
        orc: Option.getOrUndefined(args.listed.orc),
        sessions: args.sessions,
        now: args.now,
        days: historyDays,
        interval: args.interval,
      }),
      zone: args.zone,
    },
    listing: args.listed.tasks,
    pueue,
    freshness,
  };
};

export const readTaskLevels = (polls: TaskPolls, readSessions: Effect.Effect<SessionQuotaView | undefined>, interval: Interval = "today"): Effect.Effect<TaskRead, never, TaskSamplesSource> =>
  Effect.gen(function* () {
    const history = yield* TaskSamplesSource;
    const sampledAt = yield* DateTime.now;
    const [listed, live, queue, samples, sessions] = yield* Effect.all(
      [listedWithPipelines(polls), polls.live, polls.pueue, history.read(sampledAt), readSessions],
      { concurrency: "unbounded" },
    );
    return taskReadOf({
      machine: polls.machine,
      origin: "local",
      liveConfigured: true,
      listed,
      live,
      queue,
      samples,
      sessions,
      now: yield* DateTime.now,
      zone: DateTime.zoneMakeLocal(),
      interval,
      extraFreshness: [],
    });
  });

export const readRemoteTaskLevels = (polls: RemotePolls, readSessions: Effect.Effect<SessionQuotaView | undefined>, interval: Interval = "today"): Effect.Effect<TaskRead> =>
  Effect.gen(function* () {
    const [listed, live, queue, samples, sessions] = yield* Effect.all([listedWithPipelines(polls), polls.live, polls.pueue, polls.samples, readSessions], {
      concurrency: "unbounded",
    });
    return taskReadOf({
      machine: polls.machine,
      origin: "remote",
      liveConfigured: polls.liveConfigured,
      listed,
      live,
      queue,
      samples: Option.getOrElse(Option.map(samples, (held) => held.value), () => []),
      sessions,
      now: yield* DateTime.now,
      zone: DateTime.zoneMakeLocal(),
      interval,
      extraFreshness: freshnessEntry(Option.getOrUndefined(Option.map(samples, (held) => held.at))),
    });
  });


export const finishedTaskPolls: Effect.Effect<TaskPolls, Config.ConfigError, TaskPollSources> = Effect.gen(function* () {
  const names = yield* machineNames;
  const local = yield* LocalTasks;
  const pueue = yield* localMachine(PueueMachines);
  const services = yield* Effect.context<TaskProcessesSource | HostSources>();
  const mistakes = yield* localMachine(NoMistakesMachines);
  const orcs = yield* localMachine(OrcMachines);
  const stamp = <A>(read: Effect.Effect<A>): Effect.Effect<Option.Option<Stamped<A>>> => Effect.asSome(stampedNow(read));
  return {
    machine: names.local,
    tasks: Option.isSome(local) ? stampedNow(Effect.map(local.value.read, (reading): TaskListing => reading)) : unsetListing,
    live: stamp(Effect.provideContext(readLive, services)),
    pueue: pueue === undefined ? Effect.succeedNone : stamp(pueue.read),
    noMistakes: (folders) => (mistakes === undefined ? Effect.succeedNone : stamp(mistakes.read(folders))),
    orc: (folders) => (orcs === undefined ? Effect.succeedNone : stamp(orcs.read(folders))),
    refreshing: Effect.succeed(false),
    listingsRefreshing: Effect.succeed(false),
  };
});

export const finishedRemoteTaskPolls: Effect.Effect<RemotePolls | undefined, Config.ConfigError, RemoteTaskPollSources> = Effect.gen(
  function* () {
    const pieces = yield* remotePieces;
    if (pieces === undefined) return undefined;
    const { machine, remote, pueue, mistakes, orcs, history, live: liveMachine } = pieces;
    const stamp = <A>(read: Effect.Effect<A>): Effect.Effect<Option.Option<Stamped<A>>> => Effect.asSome(stampedNow(read));
    const stampedSamples: Effect.Effect<Option.Option<Stamped<ReadonlyArray<TaskSampleRecord>>>> = Option.isSome(history)
      ? stamp(Effect.map(history.value.read, historySamples))
      : Effect.succeedNone;
    return {
      machine,
      tasks: stampedNow(Effect.map(remote.read, (reading): TaskListing => reading)),
      live: Option.isSome(liveMachine) ? stamp(liveMachine.value.read) : Effect.succeedNone,
      liveConfigured: Option.isSome(liveMachine),
      pueue: pueue === undefined ? Effect.succeedNone : stamp(pueue.read),
      noMistakes: (folders) => (mistakes === undefined ? Effect.succeedNone : stamp(mistakes.read(folders))),
      orc: (folders) => (orcs === undefined ? Effect.succeedNone : stamp(orcs.read(folders))),
      samples: stampedSamples,
      refreshing: Effect.succeed(false),
      listingsRefreshing: Effect.succeed(false),
    };
  },
);

