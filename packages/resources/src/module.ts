import { Effect } from "effect";
import { type Freshness, type HostSources, machinesCadence, refreshingOf, ResourceMachines, type SavedReadings, type TaskBoard, TaskBoardFeed } from "@tui-dash/schema";
import {
  type Block,
  boxOf,
  everyText,
  frameRows,
  mountedOf,
  noSettings,
  type NoSettings,
  panelChrome,
  panelModule,
  type PanelModule,
  type Placed,
  singleTitle,
  span,
} from "@tui-dash/ui";
import { printResourcesFrame, runResourcesPanel } from "./app";
import { type Machines, machinesBoxLines } from "./machines-box";
import { machinesFeed, type MachinesShown } from "./machines-feed";
import { resourcesSection } from "./sections";

export interface MachinesReading {
  readonly machines: MachinesShown;
  readonly board: TaskBoard;
  readonly refreshing: boolean;
}

// A machine with a tasks report but no resources reading still shows its name, so its name joins the list.
const machinesOf = (reading: MachinesReading): Machines => {
  const { shown } = reading.machines;
  const resourceNames = shown.kind === "pending" ? [] : shown.value.machines.map((machine) => machine.name);
  const names = [...resourceNames, ...[...reading.board.byMachine.keys()].filter((name) => !resourceNames.includes(name))];
  return { names, local: reading.board.levels.machine };
};

const readingLines: Block = [[span("reading the machines\u2026", "muted")]];

export const machinesPlaced = (reading: () => MachinesReading): Placed => {
  const lines = (inner: number): Block => {
    const { machines, board } = reading();
    return machines.shown.kind === "pending"
      ? readingLines
      : machinesBoxLines(machines.shown.value, machinesOf(reading()), board.byMachine, board.zone, inner);
  };
  return {
    box: (size, look) => ({
      block: boxOf(singleTitle("machines", everyText(machinesCadence), size.columns, look.focused), lines(size.columns - panelChrome), size, look),
      targets: [],
    }),
    natural: (width) => lines(width - panelChrome).length + frameRows,
    least: () => frameRows + 1,
    glance: (width) => {
      const { shown } = reading().machines;
      return shown.kind === "pending" ? [readingLines] : [resourcesSection(shown.value, width)];
    },
  };
};

type MachinesSources = HostSources | ResourceMachines | SavedReadings | TaskBoardFeed;

const mountMachines = Effect.gen(function* () {
  const machines = yield* machinesFeed;
  const board = yield* TaskBoardFeed;
  return yield* mountedOf({
    name: "machines",
    cadence: machinesCadence,
    reach: "none",
    read: Effect.gen(function* () {
      const reading = yield* Effect.all({ machines: machines.read, board: board.read }, { concurrency: "unbounded" });
      yield* Effect.yieldNow;
      return { ...reading, refreshing: yield* refreshingOf([machines, board]) };
    }),
    pending: (reading) => !reading.machines.answered || reading.machines.shown.kind !== "live",
    refreshing: (reading) => reading.refreshing,
    freshness: (reading): ReadonlyArray<Freshness> => [...reading.machines.freshness, ...reading.board.freshness],
    placed: machinesPlaced,
  });
});

export const resourcesModule: PanelModule<MachinesSources> = panelModule<NoSettings, MachinesSources>({
  id: "resources",
  about: "cpu, memory, gpu and disk on each machine, and the tasks over their share",
  settings: noSettings,
  mount: () => mountMachines,
  run: () => runResourcesPanel,
  print: (_, frame) => printResourcesFrame(frame.width, frame.height, frame.color),
});
