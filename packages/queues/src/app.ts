import type { CliRenderer } from "@opentui/core";
import { DateTime, Effect, Option, type Scope } from "effect";
import {
  type ActionRun,
  ActionsSource,
  copyPathsOfStatus,
  type Freshness,
  knownProjects,
  type Outcome,
  type PueueMachine,
  type PueueStatus,
  PueueMachines,
  type QueueReadings,
  queuesPending,
  type QueuesReport,
  queuesReport,
  queuesView,
  type QueuesView,
  type Reading,
  refreshingOf,
  type BackgroundTuning,
  type Stamped,
  stampedInBackground,
  stampedNow,
} from "@tui-dash/schema";
import { type Block, livePanel as liveUiPanel, type Panel, panelWidth, printFrame, runPanel } from "@tui-dash/ui";
import { queueLines } from "./panels";

export type QueueSources = PueueMachines | ActionsSource;

type Polled<A> = Effect.Effect<Option.Option<Stamped<Outcome<A>>>>;

interface PolledMachine {
  readonly name: string;
  readonly read: Polled<PueueStatus>;
}

export interface QueueRead {
  readonly fresh: QueueReadings;
  readonly answered: Option.Option<Stamped<QueueReadings>>;
  readonly freshness: ReadonlyArray<Freshness>;
}

const valueOf = <A>(stamped: Option.Option<Stamped<A>>): Option.Option<A> => Option.map(stamped, (answer) => answer.value);

// A cached Actions answer keeps its read time, not the poll that reused it.
const actionsStamped = (read: Effect.Effect<Reading<ReadonlyArray<ActionRun>>>): Effect.Effect<Stamped<Outcome<ReadonlyArray<ActionRun>>>> =>
  Effect.map(read, (reading) => ({ value: reading, at: DateTime.toEpochMillis(reading.capturedAt) }));

const freshnessOf = (statuses: ReadonlyArray<{ readonly status: Option.Option<Stamped<Outcome<PueueStatus>>> }>, actions: Option.Option<Stamped<Outcome<ReadonlyArray<ActionRun>>>>): ReadonlyArray<Freshness> => [
  ...statuses.flatMap(({ status }) => (Option.isSome(status) ? [{ at: status.value.at, kind: "live" as const }] : [])),
  ...(Option.isSome(actions) ? [{ at: actions.value.at, kind: "live" as const }] : []),
];

const readingsOf = (machines: ReadonlyArray<PolledMachine>, repo: string, runs: Polled<ReadonlyArray<ActionRun>>): Effect.Effect<QueueRead> =>
  Effect.map(
    Effect.all(
      [
        Effect.forEach(machines, (machine) => Effect.map(machine.read, (status) => ({ name: machine.name, status })), {
          concurrency: "unbounded",
        }),
        runs,
      ],
      { concurrency: "unbounded" },
    ),
    ([statuses, actions]) => {
      const fresh = { machines: statuses.map(({ name, status }) => ({ name, status: valueOf(status) })), actions: { repo, runs: valueOf(actions) } };
      const ats = Option.all([...statuses.map(({ status }) => status), actions]);
      return {
        fresh,
        answered: Option.map(ats, (answers) => ({ value: fresh, at: Math.min(...answers.map((answer) => answer.at)) })),
        freshness: freshnessOf(statuses, actions),
      };
    },
  );

const readNamingCopies = (machine: PueueMachine): Effect.Effect<Reading<PueueStatus>> =>
  Effect.tap(machine.read, (reading) => (reading.kind === "ok" ? machine.projects.resolve(copyPathsOfStatus(reading.value)) : Effect.void));

export const readQueueReadings: Effect.Effect<QueueRead, never, QueueSources> = Effect.gen(function* () {
  const machines = yield* PueueMachines;
  const actions = yield* ActionsSource;
  const finished = machines.map((machine) => ({ name: machine.name, read: Effect.asSome(stampedNow(readNamingCopies(machine))) }));
  return yield* readingsOf(finished, actions.repo, Effect.asSome(actionsStamped(actions.read)));
});

export const readQueues: Effect.Effect<QueuesView, never, QueueSources> = Effect.gen(function* () {
  const machines = yield* PueueMachines;
  return queuesView((yield* readQueueReadings).fresh, yield* knownProjects(machines));
});

export const readQueuesReport: Effect.Effect<QueuesReport, never, QueueSources> = Effect.gen(function* () {
  const machines = yield* PueueMachines;
  const actions = yield* ActionsSource;
  const [statuses, runs] = yield* Effect.all(
    [
      Effect.forEach(machines, (machine) => Effect.map(readNamingCopies(machine), (status) => ({ name: machine.name, status })), {
        concurrency: "unbounded",
      }),
      actions.read,
    ],
    { concurrency: "unbounded" },
  );
  return queuesReport({ machines: statuses, actions: { repo: actions.repo, runs } }, yield* knownProjects(machines));
});

const patience = "2 seconds";

// A peer's ssh or GitHub can take its whole timeout, so each source reads on its own fiber and one not yet answered shows as reading.
export const backgroundQueueReadings = (
  tuning?: BackgroundTuning,
): Effect.Effect<{ readonly read: Effect.Effect<QueueRead>; readonly refreshing: Effect.Effect<boolean> }, never, QueueSources | Scope.Scope> =>
  Effect.gen(function* () {
    const wait = tuning?.patience ?? patience;
    const options = { revalidate: tuning?.revalidate };
    const machines = yield* PueueMachines;
    const actions = yield* ActionsSource;
    const polls = yield* Effect.forEach(machines, (machine) =>
      Effect.map(stampedInBackground(() => readNamingCopies(machine), wait, options), (poll) => ({ name: machine.name, poll })),
    );
    const runs = yield* stampedInBackground(() => actions.read, wait, options);
    const reads = polls.map(({ name, poll }) => ({ name, read: poll.read(undefined) }));
    const runsAt = Effect.map(runs.read(undefined), Option.map((stamped) => ({ value: stamped.value, at: DateTime.toEpochMillis(stamped.value.capturedAt) })));
    return {
      read: readingsOf(reads, actions.repo, runsAt),
      refreshing: refreshingOf([...polls.map(({ poll }) => poll), runs]),
    };
  });

export const backgroundQueues: Effect.Effect<Effect.Effect<QueuesView>, never, QueueSources | Scope.Scope> = Effect.map(
  Effect.all([PueueMachines, backgroundQueueReadings()], { concurrency: "unbounded" }),
  ([machines, feeds]) => Effect.map(Effect.all([feeds.read, knownProjects(machines)]), ([readings, projects]) => queuesView(readings.fresh, projects)),
);

interface Readings {
  readonly view: QueuesView;
  readonly now: DateTime.Utc;
}

const panelLines = (readings: Readings, columns: number, rows: number): Block =>
  queueLines(readings.view, panelWidth(columns), rows, readings.now);

const queuesPanel = <R>(read: Effect.Effect<QueuesView, never, R>): Panel<Readings, R> => ({
  read: Effect.gen(function* () {
    const view = yield* read;
    const now = yield* DateTime.now;
    return { view, now };
  }),
  lines: panelLines,
  pending: (readings) => queuesPending(readings.view),
});

export const livePanel = (renderer: CliRenderer): Effect.Effect<void, never, QueueSources> =>
  Effect.scoped(Effect.flatMap(backgroundQueues, (read) => liveUiPanel(renderer, queuesPanel(read), "10 seconds")));

export const runQueuesPanel: Effect.Effect<void, never, QueueSources> = Effect.scoped(
  Effect.flatMap(backgroundQueues, (read) => runPanel(queuesPanel(read), "10 seconds")),
);

export const printQueuesFrame = (width: number, height: number = Number.POSITIVE_INFINITY, color = false): Effect.Effect<void, never, QueueSources> =>
  printFrame(queuesPanel(readQueues), width, height, color);
