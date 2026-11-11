import { Effect, Option, type Scope } from "effect";
import { DispatchSource, dispatchView, type DispatchReading as SnapshotReading, type DispatchView, readsCadence } from "@avi2dg/orc-schema";
import {
  labelledReadings,
  leastLabelWidth,
  listPlaced,
  type Mounted,
  mountPolled,
  noSettings,
  type NoSettings,
  panelModule,
  type PanelModule,
  type Placed,
  type PolledReading,
  printSolo,
  reading as makeReading,
  runSolo,
  sentence,
  type Block,
  type Label,
} from "@avi2dg/orc-ui";
import { dispatchLines } from "./panels";
import { dispatchSection } from "./sections";

export type DispatchSources = DispatchSource;

export type DispatchReading = PolledReading<SnapshotReading>;

const viewOf = (reading: DispatchReading): DispatchView | undefined =>
  Option.isNone(reading.latest) ? undefined : dispatchView(reading.latest.value.value.snapshot);

const pendingLines = (inner: number): Block => sentence("reading the backlog\u2026", "muted", inner);

const pendingGlance = (width: number): Block => {
  const label: Label = { text: "dispatch", width: leastLabelWidth };
  return labelledReadings(label, [makeReading("muted", "reading\u2026")], width);
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

export const mountDispatch: Effect.Effect<Mounted, never, DispatchSources | Scope.Scope> = Effect.gen(function* () {
  const source = yield* DispatchSource;
  return yield* mountPolled({ name: "dispatch", key: "d", cadence: readsCadence, read: source.read, placed: dispatchPlaced });
});

export const dispatchModule: PanelModule<DispatchSources> = panelModule<NoSettings, DispatchSources>({
  id: "dispatch",
  about: "the orc dispatcher's machines, room, runs and waiting tasks",
  settings: noSettings,
  mount: () => mountDispatch,
  run: () => runSolo(mountDispatch),
  print: (_, frame) => printSolo(mountDispatch, frame),
});
