import { Effect, type Schedule } from "effect";
import type { CliRenderer } from "@opentui/core";
import { type Block } from "./layout";
import type { PrintFrame } from "./module";
import { liveScreen, printBlock, runScreen, type Screen } from "./screen";

const defaultWidth = 84;

export const leastPanelWidth = 30;

const unboundedRows = Number.POSITIVE_INFINITY;

export const panelWidth = (columns: number): number => Math.max(leastPanelWidth, columns);

export const printFrameOf = (width: number | undefined, height: number | undefined, color: boolean): PrintFrame => ({
  width: width === undefined ? defaultWidth : panelWidth(width),
  height: height ?? unboundedRows,
  color,
});

export interface Panel<A, R> {
  readonly read: Effect.Effect<A, never, R>;
  readonly lines: (value: A, columns: number, rows: number) => Block;
  readonly pending?: (value: A) => boolean;
}

const stillScreen = <A, R>(panel: Panel<A, R>): Screen<A, undefined, R> => ({
  read: panel.read,
  initial: undefined,
  draw: (value, _state, columns, rows) => ({ block: panel.lines(value, columns, rows), targets: [] }),
  move: (_value, state) => state,
  ...(panel.pending === undefined ? {} : { pending: panel.pending }),
});

export const livePanel = <A, R>(
  renderer: CliRenderer,
  panel: Panel<A, R>,
  refresh: Parameters<typeof Schedule.spaced>[0],
): Effect.Effect<void, never, R> => liveScreen(renderer, stillScreen(panel), refresh);

export const runPanel = <A, R>(panel: Panel<A, R>, refresh: Parameters<typeof Schedule.spaced>[0]): Effect.Effect<void, never, R> =>
  runScreen(stillScreen(panel), refresh);

export const printFrame = <A, R>(panel: Panel<A, R>, width: number, height: number = unboundedRows, color = false): Effect.Effect<void, never, R> =>
  Effect.flatMap(panel.read, (value) => printBlock(panel.lines(value, width, height), width, color));
