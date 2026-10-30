import type { Duration } from "effect";
import { everyText } from "./cadence";
import { type Block, type Frame, panelChrome, panelLine, titleRoom, withinRows } from "./layout";
import type { Look, Placed } from "./module";
import type { ScreenSize } from "./screen";
import { ellipsize, fit, keyedName, type Line, rightSpan, span, truncate, widthOf } from "./text";

export const frameRows = 2;

export const focusFrame: Frame = { weight: "light", tone: "focus" };

export const restFrame: Frame = { weight: "light", tone: "muted" };

const shortCadence = (cadence: string): string => `\u21bb ${cadence.replace(/^every /, "")}`;

const rightCadence = (cadence: string): Line => [rightSpan(shortCadence(cadence), "muted")];

export const cadencedTitle = (name: string, cadence: string, width: number, active = false, key?: string): Line => {
  const room = titleRoom(width) - widthOf(shortCadence(cadence)) - 2;
  const head = ellipsize(name, room);
  return [...keyedName(head, active ? "focus" : "foreground", active ? { bold: true } : {}, key), ...rightCadence(cadence)];
};

export const singleTitle = (name: string, cadence: string, width: number, active = false, key?: string): Line => cadencedTitle(name, cadence, width, active, key);

export interface Tab {
  readonly name: string;
  readonly key: string | undefined;
}

// The open name reads in focus blue with its hotkey letter accented, while a shut name rests grey apart from its hotkey letter.
export const tabsTitle = (tabs: ReadonlyArray<Tab>, open: string, cadence: string, width: number): Line => {
  const named = (tab: Tab): Line => (tab.name === open ? keyedName(tab.name, "focus", { bold: true }, tab.key) : keyedName(tab.name, "muted", {}, tab.key)).map((part) => ({ ...part, tab: tab.name }));
  const names = tabs.flatMap((tab, index): Line => [...(index === 0 ? [] : [span(" | ", "muted")]), ...named(tab)]);
  return [...truncate(names, titleRoom(width) - 6), ...rightCadence(cadence)];
};

export const fittedRows = (candidates: ReadonlyArray<Block>, room: number): Block => {
  const fitting = candidates.find((block) => block.length <= room);
  return fitting ?? withinRows(candidates.at(-1) ?? [], room);
};

export const panelled = (title: Line, lines: Block, width: number, height: number, frame: Frame = restFrame): Block => {
  const inner = withinRows(lines, Math.max(0, height - frameRows));
  return panelLine(
    title,
    [...inner, ...Array.from({ length: Math.max(0, height - frameRows - inner.length) }, (): Line => [])],
    width,
    frame,
  );
};

export const lookFrame = (look: Look): Frame => (look.focused ? focusFrame : restFrame);

// Rows left for the box's own lines once its frame and the shut tabs' lines are counted.
export const boxRoom = (size: ScreenSize, look: Look): number => Math.max(0, size.rows - frameRows - look.below.length);

export const boxOf = (title: Line, lines: Block, size: ScreenSize, look: Look): Block =>
  panelled(look.title ?? title, [...withinRows(lines, boxRoom(size, look)), ...look.below], size.columns, size.rows, lookFrame(look));

export interface ListBox {
  readonly name: string;
  readonly key: string;
  readonly cadence: Duration.Input;
  // No more than room lines, each at most inner columns wide.
  readonly lines: (inner: number, room: number) => Block;
  readonly glance: (width: number) => ReadonlyArray<Block>;
}

export const listPlaced = (list: ListBox): Placed => ({
  box: (size, look) => {
    const title = singleTitle(list.name, everyText(list.cadence), size.columns, look.focused, list.key);
    return { block: boxOf(title, list.lines(size.columns - panelChrome, boxRoom(size, look)), size, look), targets: [] };
  },
  natural: (width) => list.lines(width - panelChrome, Number.POSITIVE_INFINITY).length + frameRows,
  least: () => frameRows + 2,
  glance: list.glance,
});

export const countdownFrom = (from: number): ReadonlyArray<number> => Array.from({ length: from + 1 }, (_, index) => from - index);

export const sideBySide = (columns: ReadonlyArray<{ readonly width: number; readonly block: Block }>, height: number): Block =>
  Array.from({ length: height }, (_, row): Line => columns.flatMap(({ width, block }) => fit(block.at(row) ?? [], width)));

export const splitWidth = (width: number, parts: number): ReadonlyArray<number> =>
  Array.from({ length: parts }, (_, index) => Math.floor(width / parts) + (index < width % parts ? 1 : 0));
