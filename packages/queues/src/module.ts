import { DateTime, Effect, Option } from "effect";
import {
  type CiRuns,
  type Freshness,
  freshOf,
  machineQueue,
  type MachineProjects,
  knownProjects,
  PueueMachines,
  QueueFeed,
  type QueueShown,
  queuesView,
  type QueuesView,
  readsCadence,
  refreshingOf,
  type RunOwners,
  type SavedReadings,
  shownValue,
  type TaskBoard,
  TaskBoardFeed,
} from "@tui-dash/schema";
import { listPlaced, mountedOf, noSettings, type NoSettings, panelModule, type PanelModule, type Placed } from "@tui-dash/ui";
import { printQueuesFrame, type QueueSources, runQueuesPanel } from "./app";
import { ciFeed, type CiShown } from "./ci-feed";
import { type CiState, type QueueBoxReadings, queueBoxLines } from "./queue-box";
import { queuesSection } from "./sections";

export interface QueueReading {
  readonly queue: QueueShown;
  readonly ci: CiShown;
  readonly board: TaskBoard;
  readonly projects: MachineProjects;
  readonly now: DateTime.Utc;
  readonly refreshing: boolean;
}

const ciStateOf = (ci: CiShown): CiState => (ci.kind === "unset" || ci.kind === "pending" ? ci : ci.value);

const viewOf = (reading: QueueReading): QueuesView => queuesView(shownValue(reading.queue.shown) ?? reading.queue.fresh, reading.projects);

// A test run a task started belongs to that task, so the queue names the task instead of the bare command.
const ownersOf = (board: TaskBoard, machine: string): RunOwners => {
  const levels = machine === board.levels.machine ? (board.byMachine.get(machine) ?? board.levels) : board.byMachine.get(machine);
  const tested = (levels?.projects ?? []).flatMap((project) => project.tasks.flatMap((task) => task.tests.map((run) => [run.id, task.id] as const)));
  return new Map([...(levels?.runOwners ?? []), ...tested]);
};

const boxReadingsOf = (reading: QueueReading): QueueBoxReadings => {
  const view = viewOf(reading);
  const ci = ciStateOf(reading.ci);
  const entries = view.machines.map((machine) => {
    const pueue = Option.isSome(machine.pueue) && machine.pueue.value.kind === "ok" ? machine.pueue.value.value : undefined;
    return { machine: machine.name, pueue, owners: ownersOf(reading.board, machine.name) };
  });
  return {
    queue: machineQueue(entries, ci.kind === "ok" ? ci.value.runs : [], reading.now),
    pueues: view.machines.map((machine) => ({ name: machine.name, pueue: machine.pueue })),
    ci,
  };
};

const ciFreshness = (ci: QueueReading["ci"]): ReadonlyArray<Freshness> => {
  if (ci.kind === "unset" || ci.kind === "pending") return [];
  return freshOf(ci);
};

const queueFreshness = (reading: QueueReading): ReadonlyArray<Freshness> => [...reading.queue.freshness, ...ciFreshness(reading.ci), ...reading.board.freshness];

export const queuePlaced = (reading: () => QueueReading): Placed =>
  listPlaced({
    name: "queue",
    key: "u",
    cadence: readsCadence,
    lines: (inner, room) => queueBoxLines(boxReadingsOf(reading()), reading().now, reading().board.zone, inner, room),
    glance: (width) => [queuesSection(viewOf(reading()), width)],
  });

type QueueModuleSources = QueueSources | CiRuns | SavedReadings | QueueFeed | TaskBoardFeed;

const mountQueue = Effect.gen(function* () {
  const queue = yield* QueueFeed;
  const ci = yield* ciFeed;
  const board = yield* TaskBoardFeed;
  const machines = yield* PueueMachines;
  return yield* mountedOf({
    name: "queue",
    key: "u",
    cadence: readsCadence,
    reach: "none",
    read: Effect.gen(function* () {
      const reading = yield* Effect.all(
        { queue: queue.read, ci: ci.read, board: board.read, projects: knownProjects(machines), now: DateTime.now },
        { concurrency: "unbounded" },
      );
      yield* Effect.yieldNow;
      return { ...reading, refreshing: yield* refreshingOf([queue, ci, board]) };
    }),
    pending: (reading) => reading.queue.shown.kind !== "live" || (reading.ci.kind !== "unset" && reading.ci.kind !== "live"),
    refreshing: (reading) => reading.refreshing,
    freshness: (reading) => queueFreshness(reading),
    placed: queuePlaced,
  });
});

export const queuesModule: PanelModule<QueueModuleSources> = panelModule<NoSettings, QueueModuleSources>({
  id: "queues",
  about: "pueue on each machine and the GitHub Actions runs of the watched repositories",
  settings: noSettings,
  mount: () => mountQueue,
  run: () => runQueuesPanel,
  print: (_, frame) => printQueuesFrame(frame.width, frame.height, frame.color),
});
