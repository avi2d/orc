import { widthOf } from "@tui-dash/ui";

type Cells = ReadonlyArray<string>;

export interface Screen {
  readonly columns: number;
  readonly rows: ReadonlyArray<Cells>;
}

interface Box {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}

const graphemes = new Intl.Segmenter();

// A wide grapheme takes two cells, so the cell after it holds the empty string.
const cellsOf = (line: string): Cells =>
  [...graphemes.segment(line)].flatMap(({ segment }) => {
    const width = widthOf(segment);
    if (width === 0) return [];
    return width === 2 ? [segment, ""] : [segment];
  });

export const screenOf = (lines: ReadonlyArray<string>, columns: number): Screen => ({ columns, rows: lines.map(cellsOf) });

const topLeft = /^[╭┏]$/u;
const topRight = /^[╮┓]$/u;
const bottomLeft = /^[╰┗]$/u;
const bottomRight = /^[╯┛]$/u;
const side = /^[│┃]$/u;

// Between its corners an edge is edge cells, and each label on it sits a space inside an edge cell on either side.
const intactEdge = /^[─━]+(?: [^─-╿]+ [─━]+)*$/u;

const cellAt = (screen: Screen, row: number, column: number): string => screen.rows.at(row)?.at(column) ?? " ";

const textOf = (screen: Screen, row: number, from: number, to: number): string =>
  Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => cellAt(screen, row, from + index)).join("");

const where = (box: Box): string => `the box at row ${box.top}, column ${box.left}`;

// A box opens at a top-left corner and closes at the first top-right corner along its row and the first bottom-left corner down its column.
const boxesOf = (screen: Screen): ReadonlyArray<Box> =>
  screen.rows.flatMap((cells, top) =>
    cells.flatMap((cell, left): ReadonlyArray<Box> => {
      if (!topLeft.test(cell)) return [];
      const right = cells.findIndex((other, index) => index > left && topRight.test(other));
      const bottom = screen.rows.findIndex((_, index) => index > top && bottomLeft.test(cellAt(screen, index, left)));
      return right === -1 || bottom === -1 ? [] : [{ top, left, bottom, right }];
    }),
  );

export const pastTheRightEdge = (screen: Screen): ReadonlyArray<string> =>
  screen.rows.flatMap((cells, row) => (cells.length > screen.columns ? [`row ${row} runs ${cells.length - screen.columns} cells past the right edge`] : []));

const overlapping = (one: Box, other: Box): boolean =>
  one.left <= other.right && other.left <= one.right && one.top <= other.bottom && other.top <= one.bottom;

export const sharedCells = (screen: Screen): ReadonlyArray<string> => {
  const boxes = boxesOf(screen);
  return boxes.flatMap((one, index) => boxes.slice(index + 1).flatMap((other) => (overlapping(one, other) ? [`${where(one)} shares cells with ${where(other)}`] : [])));
};

export const textOverFrames = (screen: Screen): ReadonlyArray<string> =>
  boxesOf(screen).flatMap((box) => {
    const corner = cellAt(screen, box.bottom, box.right);
    const corners = bottomRight.test(corner) ? [] : [`${where(box)} has ${JSON.stringify(corner)} over its bottom-right corner`];
    const sides = Array.from({ length: box.bottom - box.top - 1 }, (_, index) => box.top + 1 + index).flatMap((row) =>
      [box.left, box.right].flatMap((column) => {
        const cell = cellAt(screen, row, column);
        return side.test(cell) ? [] : [`${where(box)} has ${JSON.stringify(cell)} over its side at row ${row}`];
      }),
    );
    const edges = [box.top, box.bottom].flatMap((row) => {
      const edge = textOf(screen, row, box.left + 1, box.right - 1);
      return intactEdge.test(edge) ? [] : [`${where(box)} has text over its edge at row ${row}: ${JSON.stringify(edge)}`];
    });
    return [...corners, ...sides, ...edges];
  });

// closeTop pins the cadence as " ↻ <cadence> " followed by one edge cell and the corner.
const pinnedCadence = /↻ [^ ─━]+ [─━]$/u;

export const cadencesOffTheRight = (screen: Screen): ReadonlyArray<string> =>
  boxesOf(screen).flatMap((box) => {
    const edge = textOf(screen, box.top, box.left + 1, box.right - 1);
    return !edge.includes("↻") || pinnedCadence.test(edge) ? [] : [`${where(box)} carries its cadence away from the right end: ${JSON.stringify(edge)}`];
  });

interface Region {
  readonly from: number;
  readonly to: number;
  readonly rows: ReadonlyArray<number>;
}

const range = (from: number, to: number): ReadonlyArray<number> => Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index);

// A box's text runs between the space inside each side, and a row no box crosses runs the whole screen.
const regionsOf = (screen: Screen): ReadonlyArray<Region> => {
  const boxes = boxesOf(screen);
  const open = screen.rows.flatMap((_, row) => (boxes.some((box) => box.top <= row && row <= box.bottom) ? [] : [row]));
  return [
    ...boxes.map((box) => ({ from: box.left + 2, to: box.right - 2, rows: range(box.top + 1, box.bottom - 1) })),
    { from: 0, to: screen.columns - 1, rows: open },
  ];
};

interface Spread {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const spreadOf = (screen: Screen, region: Region, row: number): Spread | undefined => {
  const text = textOf(screen, row, region.from, region.to);
  const start = text.search(/\S/u);
  if (start === -1) return undefined;
  return { start, end: text.trimEnd().length - 1, text: text.trim() };
};

const singleWord = /^\p{L}[\p{L}\p{N}_'’.-]*$/u;

// A word wrapped onto a row of its own is one that the row above, holding more than one word, had no room left for.
export const lonelyWords = (screen: Screen): ReadonlyArray<string> =>
  regionsOf(screen).flatMap((region) =>
    region.rows.slice(1).flatMap((row, index) => {
      const above = region.rows.at(index);
      if (above === undefined || above !== row - 1) return [];
      const lower = spreadOf(screen, region, row);
      const upper = spreadOf(screen, region, above);
      if (lower === undefined || upper === undefined || !singleWord.test(lower.text) || !/\s/u.test(upper.text)) return [];
      const room = region.to - region.from;
      const wrapped = lower.start >= upper.start && upper.end + 1 + widthOf(lower.text) > room;
      return wrapped ? [`row ${row} holds ${JSON.stringify(lower.text)} alone under ${JSON.stringify(upper.text)}`] : [];
    }),
  );
