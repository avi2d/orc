import { DateTime, Effect, Option } from "effect";
import { alertsPlaced } from "@tui-dash/alerts";
import { boardOf, decodeLayout, type HostState, hostScreen, layoutPanels, type Member } from "@tui-dash/dashboard";
import { ledgerPlaced } from "@tui-dash/ledger";
import { queuePlaced } from "@tui-dash/queues";
import { quotaPlaced } from "@tui-dash/quota";
import { machinesPlaced } from "@tui-dash/resources";
import { schedulesPlaced } from "@tui-dash/schedules";
import { loopTick, machinesCadence, readsCadence, type Shown, type TaskBoard } from "@tui-dash/schema";
import { sessionsPlaced } from "@tui-dash/session-quota";
import { tasksPlaced } from "@tui-dash/tasks";
import { type Block, type Drawn, type FocusReach, type Mounted, type Move, type Placed, plain, type Screen, type ScreenSize } from "@tui-dash/ui";
import { type BandedReadings, bandedReadings } from "./banded-fixture";

interface Fixed {
  readonly name: string;
  readonly key?: string;
  readonly cadence: Mounted["cadence"];
  readonly reach: FocusReach;
  readonly start: Placed;
}

const fixed = ({ name, key, cadence, reach, start }: Fixed): Mounted => ({
  name,
  key,
  cadence,
  reach,
  refresh: Effect.void,
  pending: () => false,
  refreshing: () => false,
  freshness: () => [],
  start,
});

const shownOf = <A>(value: Option.Option<A>, at: number): Shown<A> => (Option.isSome(value) ? { kind: "live", value: value.value, at } : { kind: "pending" });

const boardOfReadings = (banded: BandedReadings): TaskBoard => ({
  levels: banded.tasks.levels,
  byMachine: banded.tasks.byMachine,
  zone: banded.tasks.zone,
  listings: banded.listings,
  shownAt: new Map(),
  freshness: [],
});

// The fixture's readings, shaped as each panel module reads them.
const fixtureModules = (banded: BandedReadings = bandedReadings()): ReadonlyMap<string, Mounted> => {
  const { now } = banded;
  const at = DateTime.toEpochMillis(now);
  const board = boardOfReadings(banded);
  const listed = { local: board.levels.machine, zone: board.zone, listings: board.listings, freshness: [] };
  const queue = { shown: { kind: "live" as const, value: banded.queues, at }, fresh: banded.queues, freshness: [] };
  const schedules = Option.map(banded.schedules, (value) => ({ value, at }));
  return new Map([
    ["quota", fixed({ name: "quota", cadence: readsCadence, reach: "none", start: quotaPlaced(() => ({ shown: { kind: "live", value: banded.blocks, at }, now, refreshing: false })) })],
    ["session-quota", fixed({ name: "gluttons", key: "g", cadence: readsCadence, reach: "none", start: sessionsPlaced(() => ({ shown: shownOf(banded.sessions, at), now, refreshing: false })) })],
    ["alerts", fixed({ name: "alerts", key: "a", cadence: loopTick, reach: "none", start: alertsPlaced(() => ({ alerts: banded.alerts, now })) })],
    [
      "resources",
      fixed({ name: "machines", cadence: machinesCadence, reach: "none", start: machinesPlaced(() => ({ machines: { shown: shownOf(banded.machines, at), answered: true, freshness: [] }, board, refreshing: false })) }),
    ],
    ["queues", fixed({ name: "queue", key: "u", cadence: readsCadence, reach: "none", start: queuePlaced(() => ({ queue, ci: banded.ci, board, projects: new Map(), now, refreshing: false })) })],
    [
      "schedules",
      fixed({ name: "scheduled", key: "s", cadence: readsCadence, reach: "none", start: schedulesPlaced(() => ({ listed, queue, schedules, now, refreshing: false })) }),
    ],
    ["tasks", fixed({ name: "tasks", key: "p", cadence: readsCadence, reach: "moves", start: tasksPlaced(() => board) })],
    ["ledger", fixed({ name: "ledger", key: "l", cadence: readsCadence, reach: "key", start: ledgerPlaced(() => ({ sessions: "set", ledger: banded.ledger, now, zone: banded.tasks.zone })) })],
  ]);
};

export const membersOf = (mounted: ReadonlyMap<string, Mounted>, ids: ReadonlyArray<string>): ReadonlyArray<Member> =>
  ids.flatMap((id) => {
    const found = mounted.get(id);
    return found === undefined ? [] : [{ id, mounted: found }];
  });

// The banded dashboard as it stood before the layout setting, with the ledger beside the quota.
const bandedLayout = {
  wide: [
    {
      atLeast: { columns: 240, rows: 36 },
      rows: [
        { height: "auto", atMost: 0.55, least: 8, cells: [{ panel: "quota" }, { tabs: ["session-quota", "alerts"] }, { panel: "ledger" }] },
        { height: "fill", cells: [{ stack: [{ panel: "resources" }, { tabs: ["queues", "schedules"] }] }, { panel: "tasks", width: 2 }] },
      ],
    },
    {
      atLeast: { columns: 120, rows: 36 },
      rows: [
        { height: "auto", atMost: 0.55, least: 8, cells: [{ stack: [{ panel: "quota" }, { tabs: ["session-quota", "alerts"] }] }, { panel: "ledger" }] },
        { height: "fill", cells: [{ stack: [{ panel: "resources" }, { tabs: ["queues", "schedules"] }] }, { panel: "tasks" }] },
      ],
    },
  ],
  narrow: ["quota", "session-quota", "queues", "resources", "alerts", "tasks"],
};

export type Step = { readonly move: Move } | { readonly press: string };

const screenOf = (mounted: ReadonlyMap<string, Mounted>, layout: unknown): Screen<number, HostState, never> => {
  const decoded = Effect.runSync(decodeLayout(layout, [...mounted.keys()]));
  return hostScreen(boardOf(decoded, mounted), membersOf(mounted, layoutPanels(decoded)));
};

export const bandedScreen = (banded: BandedReadings = bandedReadings(), layout: unknown = bandedLayout): Screen<number, HostState, never> =>
  screenOf(fixtureModules(banded), layout);


export const stepped = (screen: Screen<number, HostState, never>, size: ScreenSize, steps: ReadonlyArray<Step>, from: HostState = screen.initial): HostState =>
  steps.reduce((held, step) => ("move" in step ? screen.move(0, held, step.move, size) : (screen.press?.(0, held, step.press, size) ?? held)), from);

export const bandedDrawn = (columns: number, rows: number, steps: ReadonlyArray<Step> = [], banded: BandedReadings = bandedReadings()): Drawn<HostState> => {
  const screen = bandedScreen(banded);
  return screen.draw(0, stepped(screen, { columns, rows }, steps), columns, rows);
};

export const bandedLines = (columns: number, rows: number, steps: ReadonlyArray<Step> = [], banded: BandedReadings = bandedReadings()): ReadonlyArray<string> =>
  bandedDrawn(columns, rows, steps, banded).block.map(plain);

// The narrow glance at 84 columns, without the agents or the machines unless a test gives them.
export const glanceLines = (over: Partial<BandedReadings> = {}): ReadonlyArray<string> =>
  bandedLines(84, Number.POSITIVE_INFINITY, [], { ...bandedReadings(), sessions: Option.none(), machines: Option.none(), ...over });

export const boxLines = (over: Partial<BandedReadings> = {}, steps: ReadonlyArray<Step> = []): ReadonlyArray<string> =>
  bandedLines(120, 40, steps, { ...bandedReadings(), ...over });

// The box with this title in a drawn frame, its edges included, or nothing when no box has it.
export const boxText = (frame: string, title: string): string => {
  const rows = frame.split("\n");
  const top = rows.findIndex((row) => row.includes(`╭─ ${title} `));
  const left = rows.at(top)?.indexOf(`╭─ ${title} `) ?? -1;
  const right = rows.at(top)?.indexOf("╮", left) ?? -1;
  const bottom = rows.findIndex((row, index) => index > top && row.at(left) === "╰");
  return top < 0 ? "" : rows.slice(top, bottom + 1).map((row) => row.slice(left, right + 1)).join("\n");
};

export const glanceBlock = (over: Partial<BandedReadings>, columns: number, rows: number): Block => bandedDrawn(columns, rows, [], { ...bandedReadings(), ...over }).block;
