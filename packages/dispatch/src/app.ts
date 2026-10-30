import type { CliRenderer } from "@opentui/core";
import { DateTime, Effect, Option, type Scope } from "effect";
import {
  DispatchSource,
  dispatchView,
  type DispatchView,
  type Freshness,
  type BackgroundTuning,
  refreshingOf,
  stampedInBackground,
  unreachable,
} from "@tui-dash/schema";
import { type Block, livePanel as liveUiPanel, type Panel, panelWidth, printFrame, runPanel } from "@tui-dash/ui";
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
  view: dispatchView({
    root,
    missing: true,
    machines: unreachable("reading the backlog\u2026"),
    projects: unreachable("reading the backlog\u2026"),
    tasks: [],
    unread: [],
  }),
  at: 0,
  freshness: [],
});

export const backgroundDispatchRead = (
  tuning?: BackgroundTuning,
): Effect.Effect<{ readonly read: Effect.Effect<DispatchRead>; readonly refreshing: Effect.Effect<boolean> }, never, DispatchSources | Scope.Scope> =>
  Effect.gen(function* () {
    const source = yield* DispatchSource;
    const poll = yield* stampedInBackground(() => source.read, tuning?.patience ?? "2 seconds", { revalidate: tuning?.revalidate });
    return {
      read: Effect.map(
        poll.read(undefined),
        (stamped): DispatchRead =>
          Option.isNone(stamped)
            ? pendingRead(source.root)
            : {
              view: dispatchView(stamped.value.value.snapshot),
              at: atOf(stamped.value.value.capturedAt),
              freshness: [{ at: stamped.value.at, kind: "live" }],
            },
      ),
      refreshing: refreshingOf([poll]),
    };
  });

interface Readings {
  readonly view: DispatchView;
}

const panelLines = (readings: Readings, columns: number, rows: number): Block => dispatchLines(readings.view, panelWidth(columns), rows);

export const dispatchPanel = <R>(read: Effect.Effect<DispatchView, never, R>): Panel<Readings, R> => ({
  read: Effect.map(read, (view) => ({ view })),
  lines: panelLines,
  pending: () => false,
});

export const livePanel = (renderer: CliRenderer): Effect.Effect<void, never, DispatchSources> =>
  Effect.scoped(Effect.flatMap(backgroundDispatchRead(), (feed) => liveUiPanel(renderer, dispatchPanel(Effect.map(feed.read, (read) => read.view)), "10 seconds")));

export const runDispatchPanel: Effect.Effect<void, never, DispatchSources> = Effect.scoped(
  Effect.flatMap(backgroundDispatchRead(), (feed) => runPanel(dispatchPanel(Effect.map(feed.read, (read) => read.view)), "10 seconds")),
);

export const printDispatchFrame = (width: number, height: number = Number.POSITIVE_INFINITY, color = false): Effect.Effect<void, never, DispatchSources> =>
  printFrame(dispatchPanel(Effect.map(readDispatchRead, (read) => read.view)), width, height, color);
