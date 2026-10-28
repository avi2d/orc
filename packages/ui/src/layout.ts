import type { Tone } from "./palette";
import { ellipsize, fit, type Line, lineWidth, plain, span, truncate, widthOf } from "./text";

export type Block = ReadonlyArray<Line>;

export const wrapParts = (parts: ReadonlyArray<string>, width: number, separator = " \u00b7 "): ReadonlyArray<string> =>
  parts.reduce<ReadonlyArray<string>>((lines, part) => {
    const last = lines.at(-1);
    if (last === undefined) return [part];
    const joined = last + separator + part;
    return widthOf(joined) <= width ? [...lines.slice(0, -1), joined] : [...lines, part];
  }, []);

export const withinRows = (block: Block, rows: number): Block => {
  if (block.length <= rows) return block;
  if (rows < 1) return [];
  return [...block.slice(0, rows - 1), [span(`+${block.length - rows + 1} more rows`, "muted")]];
};

export const panelChrome = 4;

export interface Frame {
  readonly weight: "light" | "heavy";
  readonly tone: Tone;
}

const lightFrame: Frame = { weight: "light", tone: "muted" };

const edges = {
  light: { across: "\u2500", down: "\u2502", topLeft: "\u256d", topRight: "\u256e", bottomLeft: "\u2570", bottomRight: "\u256f" },
  heavy: { across: "\u2501", down: "\u2503", topLeft: "\u250f", topRight: "\u2513", bottomLeft: "\u2517", bottomRight: "\u251b" },
};

const titleChrome = 5;

export const titleRoom = (width: number): number => Math.max(0, width - titleChrome);

const closeTop = (head: Line, width: number, frame: Frame): Line => {
  const edge = edges[frame.weight];
  const at = head.findIndex((part) => part.right === true);
  const body = at === -1 ? head : head.slice(0, at);
  const pinned = at === -1 ? [] : head.slice(at);
  const left = body.filter((part, index, all) => !(at !== -1 && index === all.length - 1 && part.text === " "));
  const tail: Line = at === -1 ? [] : [span(` ${plain(pinned).trimEnd()} `, "muted"), span(edge.across, frame.tone)];
  const tailWidth = at === -1 ? 0 : lineWidth(tail);
  if (at === -1) {
    const capped = lineWidth(left) > width - 1 ? truncate(left, width - 1) : left;
    return fit(
      [...capped, span(edge.across.repeat(Math.max(0, width - 1 - lineWidth(capped))), frame.tone), span(edge.topRight, frame.tone)],
      width,
    );
  }
  const room = Math.max(0, width - 1 - tailWidth - 1);
  const capped = lineWidth(left) > room ? truncate(left, room) : left;
  const opened: Line = [...capped, span(" ", frame.tone)];
  return fit(
    [...opened, span(edge.across.repeat(Math.max(0, width - 1 - lineWidth(opened) - tailWidth)), frame.tone), ...tail, span(edge.topRight, frame.tone)],
    width,
  );
};

const topEdge = (title: string, width: number, frame: Frame): Line => {
  const edge = edges[frame.weight];
  const label = ` ${ellipsize(title, titleRoom(width))} `;
  const head: Line = [span(edge.topLeft + edge.across, frame.tone), span(label, frame.tone)];
  return closeTop(head, width, frame);
};

const bottomEdge = (width: number, frame: Frame): Line => {
  const edge = edges[frame.weight];
  return [span(`${edge.bottomLeft}${edge.across.repeat(Math.max(0, width - 2))}${edge.bottomRight}`, frame.tone)];
};

const bottomCorners = [edges.light.bottomLeft, edges.heavy.bottomLeft];

export const bottomEdgeRow = (block: Block): number =>
  block.findLastIndex((line) => bottomCorners.some((corner) => line.at(0)?.text.startsWith(corner) ?? false));

const sides = (line: Line, width: number, frame: Frame): Line => [
  span(`${edges[frame.weight].down} `, frame.tone),
  ...fit(line, width - panelChrome),
  span(` ${edges[frame.weight].down}`, frame.tone),
];

export const panel = (title: string, lines: Block, width: number, frame: Frame = lightFrame): Block => [
  topEdge(title, width, frame),
  ...lines.map((line) => sides(line, width, frame)),
  bottomEdge(width, frame),
];

const topEdgeLine = (title: Line, width: number, frame: Frame): Line => {
  const edge = edges[frame.weight];
  const at = title.findIndex((part) => part.right === true);
  const body = at === -1 ? title : title.slice(0, at);
  const pinned = at === -1 ? [] : title.slice(at);
  const room = titleRoom(width) - lineWidth(pinned);
  const head: Line = [span(`${edge.topLeft}${edge.across} `, frame.tone), ...truncate(body, room), ...pinned, span(" ", frame.tone)];
  return closeTop(head, width, frame);
};

export const titleEdge = (title: Line, width: number, frame: Frame): Line => topEdgeLine(title, width, frame);

export const panelLine = (title: Line, lines: Block, width: number, frame: Frame = lightFrame): Block => [
  topEdgeLine(title, width, frame),
  ...lines.map((line) => sides(line, width, frame)),
  bottomEdge(width, frame),
];

// The caller styles each name bright or dim; the edge only frames them.
export const tabEdge = (tabs: ReadonlyArray<Line>, width: number, frame: Frame, top: boolean): Line => {
  const edge = edges[frame.weight];
  const open = top ? edge.topLeft : edge.bottomLeft;
  const shut = top ? edge.topRight : edge.bottomRight;
  const head: Array<Line[number]> = [span(`${open}${edge.across}`, frame.tone)];
  for (const tab of tabs) head.push(span("\u2510", frame.tone), ...tab, span("\u250c", frame.tone));
  return fit(
    [...head, span(edge.across.repeat(Math.max(0, width - 1 - lineWidth(head))), frame.tone), span(shut, frame.tone)],
    width,
  );
};

export const tabbedPanel = (
  tabs: ReadonlyArray<Line>,
  lines: Block,
  width: number,
  frame: Frame = lightFrame,
  bottomTabs: ReadonlyArray<Line> = [],
): Block => [
  tabEdge(tabs, width, frame, true),
  ...lines.map((line) => sides(line, width, frame)),
  bottomTabs.length === 0 ? bottomEdge(width, frame) : tabEdge(bottomTabs, width, frame, false),
];
