import { Effect, type Scope } from "effect";
import { loopTick } from "@tui-dash/schema";
import type { Look, Mounted, PanelError, Placed, PrintFrame } from "./module";
import { panelWidth } from "./panel";
import { withinRows } from "./layout";
import { type Drawn, printBlock, runScreen, type Screen, type ScreenSize } from "./screen";

const aloneLook: Look = { focused: true, title: undefined, below: [], alone: true };

// A print has no height of its own, so the box takes the rows it asks for.
const roomOf = (placed: Placed, columns: number, rows: number): ScreenSize => {
  const width = panelWidth(columns);
  return { columns: width, rows: Number.isFinite(rows) ? rows : placed.natural(width) };
};

export const drawAlone = (placed: Placed, columns: number, rows: number): Drawn<Placed> => {
  const size = roomOf(placed, columns, rows);
  return placed.whole?.(size) ?? placed.box(size, aloneLook);
};

export const soloScreen = (mounted: Mounted): Screen<boolean, Placed, never> => ({
  read: Effect.map(mounted.refresh, () => true),
  initial: mounted.start,
  draw: (_, placed, columns, rows) => drawAlone(placed, columns, rows),
  move: (_, placed, move, size) => placed.move?.(move, size) ?? placed,
  press: (_, placed, key, size) => placed.press?.(key, size) ?? placed,
  link: (_, placed, size) => placed.link?.(size),
  pending: () => mounted.pending(),
});

export const runSolo = <R>(mount: Effect.Effect<Mounted, PanelError, R | Scope.Scope>): Effect.Effect<void, PanelError, R> =>
  Effect.scoped(Effect.flatMap(mount, (mounted) => runScreen(soloScreen(mounted), loopTick)));

export const printSolo = <R>(mount: Effect.Effect<Mounted, PanelError, R | Scope.Scope>, frame: PrintFrame): Effect.Effect<void, PanelError, R> =>
  Effect.scoped(
    Effect.flatMap(mount, (mounted) => printBlock(withinRows(drawAlone(mounted.start, frame.width, frame.height).block, frame.height), panelWidth(frame.width), frame.color)),
  );
