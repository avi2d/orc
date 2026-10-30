import { Effect, type Scope } from "effect";
import { type DispatchView, type Freshness, readsCadence } from "@tui-dash/schema";
import { listPlaced, mountedOf, type Mounted, noSettings, type NoSettings, panelModule, type PanelModule, type Placed } from "@tui-dash/ui";
import { backgroundDispatchRead, type DispatchSources, printDispatchFrame, runDispatchPanel } from "./app";
import { dispatchLines } from "./panels";
import { dispatchSection } from "./sections";

export interface DispatchReading {
  readonly view: DispatchView;
  readonly at: number;
  readonly refreshing: boolean;
}

export const dispatchPlaced = (reading: () => DispatchReading): Placed =>
  listPlaced({
    name: "dispatch",
    key: "d",
    cadence: readsCadence,
    lines: (inner, room) => dispatchLines(reading().view, inner, room),
    glance: (width) => [dispatchSection(reading().view, width)],
  });

export const mountDispatch: Effect.Effect<Mounted, never, DispatchSources | Scope.Scope> = Effect.gen(function* () {
  const feed = yield* backgroundDispatchRead();
  return yield* mountedOf({
    name: "dispatch",
    key: "d",
    cadence: readsCadence,
    reach: "none",
    read: Effect.gen(function* () {
      const read = yield* feed.read;
      yield* Effect.yieldNow;
      return { view: read.view, at: read.at, refreshing: yield* feed.refreshing };
    }),
    pending: () => false,
    refreshing: (reading) => reading.refreshing,
    freshness: (reading): ReadonlyArray<Freshness> => (reading.at === 0 ? [] : [{ at: reading.at, kind: "live" }]),
    placed: dispatchPlaced,
  });
});

export const dispatchModule: PanelModule<DispatchSources> = panelModule<NoSettings, DispatchSources>({
  id: "dispatch",
  about: "the orc dispatcher's machines, room, runs and waiting tasks",
  settings: noSettings,
  mount: () => mountDispatch,
  run: () => runDispatchPanel,
  print: (_, frame) => printDispatchFrame(frame.width, frame.height, frame.color),
});
