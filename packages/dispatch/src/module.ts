import { Effect, Option, type Scope } from "effect";
import {
  DispatchSource,
  dispatchView,
  type DispatchReading as SnapshotReading,
  type DispatchView,
  freshOfStamped,
  polled,
  readsCadence,
  type Stamped,
} from "@tui-dash/schema";
import {
  labelledReadings,
  leastLabelWidth,
  listPlaced,
  mountedOf,
  type Mounted,
  noSettings,
  type NoSettings,
  panelModule,
  type PanelModule,
  type Placed,
  printSolo,
  reading,
  runSolo,
  sentence,
  type Block,
  type Label,
} from "@tui-dash/ui";
import { dispatchLines } from "./panels";
import { dispatchSection } from "./sections";

export type DispatchSources = DispatchSource;

export interface DispatchReading {
  readonly latest: Option.Option<Stamped<SnapshotReading>>;
  readonly refreshing: boolean;
}

const viewOf = (reading: DispatchReading): DispatchView | undefined =>
  Option.isNone(reading.latest) ? undefined : dispatchView(reading.latest.value.value.snapshot);

const pendingLines = (inner: number): Block => sentence("reading the backlog\u2026", "muted", inner);

const pendingGlance = (width: number): Block => {
  const label: Label = { text: "dispatch", width: leastLabelWidth };
  return labelledReadings(label, [reading("muted", "reading\u2026")], width);
};

export const dispatchPlaced = (reading: () => DispatchReading): Placed =>
  listPlaced({
    name: "dispatch",
    key: "d",
    cadence: readsCadence,
    lines: (inner, room) => {
      const view = viewOf(reading());
      return view === undefined ? pendingLines(inner) : dispatchLines(view, inner, room);
    },
    glance: (width) => {
      const view = viewOf(reading());
      return [view === undefined ? pendingGlance(width) : dispatchSection(view, width)];
    },
  });

export const mountDispatch: Effect.Effect<Mounted, never, DispatchSources | Scope> = Effect.gen(function* () {
  const poll = yield* polled((yield* DispatchSource).read, readsCadence);
  return yield* mountedOf({
    name: "dispatch",
    key: "d",
    cadence: readsCadence,
    reach: "none",
    read: Effect.gen(function* () {
      const latest = yield* poll.latest;
      yield* Effect.yieldNow;
      return { latest, refreshing: yield* poll.refreshing };
    }),
    pending: (reading) => Option.isNone(reading.latest),
    refreshing: (reading) => reading.refreshing,
    freshness: (reading) => freshOfStamped(Option.getOrUndefined(reading.latest)),
    placed: dispatchPlaced,
  });
});

export const dispatchModule: PanelModule<DispatchSources> = panelModule<NoSettings, DispatchSources>({
  id: "dispatch",
  about: "the orc dispatcher's machines, room, runs and waiting tasks",
  settings: noSettings,
  mount: () => mountDispatch,
  run: () => runSolo(mountDispatch),
  print: (_, frame) => printSolo(mountDispatch, frame),
});
