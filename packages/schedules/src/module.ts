import { DateTime, Effect, Option } from "effect";
import {
  freshOfStamped,
  type MachineListing,
  MachineSchedules,
  nextUp,
  type NextUp,
  polled,
  QueueFeed,
  type QueueShown,
  readsCadence,
  refreshingOf,
  type ScheduleRead,
  shownValue,
  type Stamped,
  TaskBoardFeed,
  type TaskListings,
} from "@tui-dash/schema";
import { listPlaced, mountedOf, noSettings, type NoSettings, panelModule, type PanelModule, type Placed, printSolo, runSolo } from "@tui-dash/ui";
import { nextLines } from "./next-box";

export interface SchedulesReading {
  readonly listed: TaskListings;
  readonly queue: QueueShown;
  readonly schedules: Option.Option<Stamped<ReadonlyArray<ScheduleRead>>>;
  readonly now: DateTime.Utc;
  readonly refreshing: boolean;
}

const orchestratorOf = ({ listing }: MachineListing) => {
  if (listing.kind === "unset") return "absent" as const;
  if (listing.kind === "pending") return "pending" as const;
  return listing.kind === "ok" ? { kind: "ok" as const, value: listing.value.view.schedules } : listing;
};

export const nextOf = (reading: SchedulesReading): NextUp => {
  const queues = shownValue(reading.queue.shown) ?? reading.queue.fresh;
  return nextUp({
    schedules: Option.getOrUndefined(reading.schedules)?.value,
    local: reading.listed.local,
    pueues: queues.machines.map((machine) => ({ machine: machine.name, status: Option.getOrUndefined(machine.status) })),
    orchestrators: reading.listed.listings.map((listing) => ({ machine: listing.machine, read: orchestratorOf(listing) })),
    now: reading.now,
    zone: reading.listed.zone,
  });
};

export const schedulesPlaced = (reading: () => SchedulesReading): Placed => {
  const lines = (inner: number, room: number) => nextLines(nextOf(reading()), reading().now, inner, room);
  return listPlaced({ name: "scheduled", key: "s", cadence: readsCadence, lines, glance: (width) => [lines(width, Number.POSITIVE_INFINITY)] });
};

type SchedulesSources = MachineSchedules | QueueFeed | TaskBoardFeed;

const mountSchedules = Effect.gen(function* () {
  const board = yield* TaskBoardFeed;
  const queue = yield* QueueFeed;
  const schedules = yield* polled((yield* MachineSchedules).read, readsCadence);
  return yield* mountedOf({
    name: "scheduled",
    key: "s",
    cadence: readsCadence,
    reach: "none",
    read: Effect.gen(function* () {
      const reading = yield* Effect.all(
        { listed: board.listings, queue: queue.read, schedules: schedules.latest, now: DateTime.now },
        { concurrency: "unbounded" },
      );
      yield* Effect.yieldNow;
      return { ...reading, refreshing: yield* refreshingOf([queue, schedules, { refreshing: board.listingsRefreshing }]) };
    }),
    pending: (reading) => Option.isNone(reading.schedules),
    refreshing: (reading) => reading.refreshing,
    freshness: (reading) => [
      ...reading.listed.freshness,
      ...reading.queue.freshness,
      ...freshOfStamped(Option.getOrUndefined(reading.schedules)),
    ],
    placed: schedulesPlaced,
  });
});

export const schedulesModule: PanelModule<SchedulesSources> = panelModule<NoSettings, SchedulesSources>({
  id: "schedules",
  about: "what runs next on each machine: timers, pueue, CI crons and the orchestrator's schedule",
  settings: noSettings,
  mount: () => mountSchedules,
  run: () => runSolo(mountSchedules),
  print: (_, frame) => printSolo(mountSchedules, frame),
});
