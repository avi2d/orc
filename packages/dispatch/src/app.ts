import type { CliRenderer } from "@opentui/core";
import { DateTime, Effect, Option, type Scope } from "effect";
import {
  DispatchSource,
  dispatchView,
  type DispatchView,
  type Freshness,
  type BackgroundTuning,
  polled,
  readsCadence,
} from "@tui-dash/schema";
import { type Block, frameRows, livePanel as liveUiPanel, type Panel, panel, panelChrome, panelWidth, printFrame, runPanel } from "@tui-dash/ui";
import { dispatchLines } from "./panels";

export type DispatchSources = DispatchSource;

export interface DispatchRead {
  readonly view: DispatchView;
  readonly at: number;
  readonly freshness: ReadonlyArray<Freshness>;
}

const atOf = (capturedAt: DateTime.Utc): number => DateTime.toEpochMillis(capturedAt);

export const readDispatchRead: Effect.Effect<DispatchRead, never, DispatchSources> = Effect.gen(function* () {
  const reading = yield* (yield* DispatchSource).read;
  yield* Effect.yieldNow;
  return { view: dispatchView(reading.snapshot), at: atOf(reading.capturedAt), freshness: [{ at: atOf(reading.capturedAt), kind: "live" }] };
});

const pendingRead = (root: string): DispatchRead => ({
  view: { root, missing: false, pending: true, machines: { kind: "ok", value: [] }, runs: [], waiting: [], unread: [] },
  at: 0,
  freshness: [],
});

export const backgroundDispatchRead = (
  tuning?: BackgroundTuning,
): Effect.Effect<{ readonly read: Effect.Effect<DispatchRead>; readonly refreshing: Effect.Effect<boolean> }, never, DispatchSources | Scope> =>
  Effect.gen(function* () {
    const source = yield* DispatchSource;
    const poll = yield* polled(source.read, tuning?.revalidate ?? readsCadence);
    return {
      read: Effect.map(
        poll.latest,
        (latest): DispatchRead =>
          Option.isNone(latest)
            ? pendingRead(source.root)
            : {
              view: dispatchView(latest.value.value.snapshot),
              at: atOf(latest.value.value.capturedAt),
              freshness: [{ at: latest.value.at, kind: "live" }],
            },
      ),
      refreshing: poll.refreshing,
    };
  });

interface Readings {
  readonly view: DispatchView;
  readonly at: number;
}

const panelLines = (readings: Readings, columns: number, rows: number): Block => {
  const width = panelWidth(columns);
  const inner = Math.max(0, width - panelChrome);
  const room = Number.isFinite(rows) ? Math.max(0, rows - frameRows) : rows;
  return panel("dispatch", dispatchLines(readings.view, inner, room), width);
};

export const dispatchPanel = <R>(read: Effect.Effect<DispatchRead, never, R>): Panel<Readings, R> => ({
  read: Effect.map(read, (resolved) => ({ view: resolved.view, at: resolved.at })),
  lines: panelLines,
  pending: (readings) => readings.view.pending,
});

export const livePanel = (renderer: CliRenderer): Effect.Effect<void, never, DispatchSources> =>
  Effect.scoped(Effect.flatMap(backgroundDispatchRead(), (feed) => liveUiPanel(renderer, dispatchPanel(feed.read), "10 seconds")));

export const runDispatchPanel: Effect.Effect<void, never, DispatchSources> = Effect.scoped(
  Effect.flatMap(backgroundDispatchRead(), (feed) => runPanel(dispatchPanel(feed.read), "10 seconds")),
);

export const printDispatchFrame = (width: number, height: number = Number.POSITIVE_INFINITY, color = false): Effect.Effect<void, never, DispatchSources> =>
  printFrame(dispatchPanel(readDispatchRead), width, height, color);
