import { type Config, DateTime, Duration, Effect, Layer, Option } from "effect";
import {
  type Freshness,
  freshOf,
  type MachineListing,
  ReadModeReference,
  readsCadence,
  reportedTasksOf,
  SavedReadings,
  type SavedSlot,
  SessionsFeed,
  shownAt,
  shownOf,
  shownValue,
  type Shown,
  type Stamped,
  type TaskBoard,
  TaskBoardFeed,
  refreshingOf,
  type TaskLevels,
  type TaskListing,
  type TaskListings,
  TaskSamplesSource,
  TasksReport,
  tasksReport,
} from "@tui-dash/schema";
import {
  backgroundRemoteTaskPollsWithin,
  backgroundTaskPollsWithin,
  finishedRemoteTaskPolls,
  finishedTaskPolls,
  readRemoteTaskLevels,
  readTaskLevels,
  type RemotePolls,
  type RemoteTaskPollSources,
  type TaskPolls,
  type TaskPollSources,
  type TaskRead,
} from "./app";

interface ListingRead {
  readonly machine: string;
  readonly fresh: Stamped<TaskListing>;
  readonly shown: Shown<TaskListing>;
}

const savedListing = (saved: Option.Option<Stamped<TasksReport>>): Option.Option<Stamped<TaskListing>> =>
  Option.flatMap(saved, ({ value, at }) => {
    const reported = reportedTasksOf(value);
    return reported.kind === "ok" ? Option.some({ value: reported, at }) : Option.none();
  });

const answered = (listed: Stamped<TaskListing>): Option.Option<Stamped<TaskListing>> => (listed.value.kind === "pending" ? Option.none() : Option.some(listed));

const shownListing = (read: ListingRead): TaskListing => shownValue(read.shown) ?? read.fresh.value;

const withListing = <P extends TaskPolls>(polls: P, read: ListingRead): P => ({
  ...polls,
  tasks: Effect.succeed({ value: shownListing(read), at: shownAt(read.shown)?.at ?? read.fresh.at }),
});

// A saved listing stands in for a report still on its way, so the levels say pending rather than nothing listed.
const withFreshTasks = (levels: TaskLevels, read: ListingRead): TaskLevels =>
  read.shown.kind === "saved" && read.fresh.value.kind === "pending" ? { ...levels, pending: true, unset: false, listed: false } : levels;

interface Machine<P extends TaskPolls> {
  readonly polls: P;
  readonly slot: SavedSlot<TasksReport>;
  readonly last: Effect.Effect<Option.Option<Stamped<TasksReport>>>;
}

const machineOf = <P extends TaskPolls>(polls: P) =>
  Effect.gen(function* () {
    const slot = (yield* SavedReadings).slot(`tasks-${polls.machine}`, TasksReport);
    return { polls, slot, last: yield* Effect.cached(slot.last) } satisfies Machine<P>;
  });

const listingRead = <P extends TaskPolls>(machine: Machine<P>) =>
  Effect.gen(function* () {
    const fresh = yield* machine.polls.tasks;
    if (fresh.value.kind === "ok") yield* machine.slot.keep(tasksReport(fresh.value.value), fresh.at);
    return { machine: machine.polls.machine, fresh, shown: shownOf(answered(fresh), savedListing(yield* machine.last)) } satisfies ListingRead;
  });

interface MachineBoard {
  readonly read: ListingRead;
  readonly levels: TaskLevels;
  readonly zone: DateTime.TimeZone;
  readonly freshness: ReadonlyArray<Freshness>;
}

interface Listed<P extends TaskPolls> {
  readonly machine: Machine<P>;
  readonly read: Effect.Effect<ListingRead>;
}

const machineBoard = <P extends TaskPolls, R>({ machine, read: listed }: Listed<P>, levelsOf: (polls: P) => Effect.Effect<TaskRead, never, R>) =>
  Effect.gen(function* () {
    const read = yield* listed;
    const task = yield* levelsOf(withListing(machine.polls, read));
    const freshness: ReadonlyArray<Freshness> = [...freshOf(read.shown), ...task.freshness];
    return { read, levels: withFreshTasks(task.readings.levels, read), zone: task.readings.zone, freshness } satisfies MachineBoard;
  });

const machineListing = (read: ListingRead): MachineListing => ({ machine: read.machine, listing: shownListing(read) });

const listingsOf = (local: Listed<TaskPolls>, remote: Listed<RemotePolls> | undefined): Effect.Effect<TaskListings> =>
  Effect.map(Effect.all([local.read, remote?.read ?? Effect.undefined], { concurrency: "unbounded" }), ([here, there]) => {
    const reads = there === undefined ? [here] : [here, there];
    return {
      local: local.machine.polls.machine,
      zone: DateTime.zoneMakeLocal(),
      listings: reads.map(machineListing),
      freshness: reads.flatMap((read) => freshOf(read.shown)),
    };
  });

const boardOf = (local: Listed<TaskPolls>, remote: Listed<RemotePolls> | undefined) =>
  Effect.gen(function* () {
    const sessions = yield* Effect.cached((yield* SessionsFeed).read);
    const values = Effect.map(sessions, shownValue);
    const [here, there, sessionsShown] = yield* Effect.all(
      [
        machineBoard(local, (polls) => readTaskLevels(polls, values, "all")),
        remote === undefined ? Effect.succeedNone : Effect.asSome(machineBoard(remote, (polls) => readRemoteTaskLevels(polls, values, "all"))),
        sessions,
      ],
      { concurrency: "unbounded" },
    );
    const machines = Option.isSome(there) ? [here, there.value] : [here];
    return {
      levels: here.levels,
      byMachine: new Map(machines.map(({ levels }) => [levels.machine, levels] as const)),
      zone: here.zone,
      listings: machines.map(({ read }) => machineListing(read)),
      shownAt: new Map(machines.flatMap(({ read }) => {
        const at = shownAt(read.shown);
        return at === undefined ? [] : [[read.machine, at] as const];
      })),
      freshness: [...machines.flatMap(({ freshness }) => freshness), ...freshOf(sessionsShown)],
    } satisfies TaskBoard;
  });

const tuning = { patience: Duration.zero, revalidate: readsCadence };

// Every panel on one paint asks for the board, and the board reads the samples file, so one paint computes it once.
const paintMillis = 1_000;

export const taskBoardFeedLayer: Layer.Layer<
  TaskBoardFeed,
  Config.ConfigError,
  TaskPollSources | RemoteTaskPollSources | TaskSamplesSource | SessionsFeed | SavedReadings
> = Layer.effect(
  TaskBoardFeed,
  Effect.gen(function* () {
    const live = (yield* ReadModeReference) === "live";
    const localPolls = live ? yield* backgroundTaskPollsWithin(tuning) : yield* finishedTaskPolls;
    const remotePolls = live ? yield* backgroundRemoteTaskPollsWithin(tuning) : yield* finishedRemoteTaskPolls;
    const once = <A>(read: Effect.Effect<A>) => (live ? Effect.cachedWithTTL(read, Duration.millis(paintMillis)) : Effect.cached(read));
    const listed = <P extends TaskPolls>(machine: Machine<P>) => Effect.map(once(listingRead(machine)), (read): Listed<P> => ({ machine, read }));
    const local = yield* listed(yield* machineOf(localPolls));
    const remote = remotePolls === undefined ? undefined : yield* listed(yield* machineOf(remotePolls));
    const services = yield* Effect.context<TaskSamplesSource | SessionsFeed>();
    const sessionsFeed = yield* SessionsFeed;
    const board = Effect.provideContext(boardOf(local, remote), services);
    const listingsRefreshing = refreshingOf(
      (remote === undefined ? [local.machine.polls] : [local.machine.polls, remote.machine.polls]).map((polls) => ({ refreshing: polls.listingsRefreshing })),
    );
    const refreshing = refreshingOf(
      remote === undefined ? [local.machine.polls, sessionsFeed] : [local.machine.polls, remote.machine.polls, sessionsFeed],
    );
    return { read: yield* once(board), listings: yield* once(listingsOf(local, remote)), refreshing, listingsRefreshing };
  }),
);
