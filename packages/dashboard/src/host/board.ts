import { Duration } from "effect";
import { savedAtOf, type Freshness } from "@tui-dash/schema";
import { everyText, leastPanelWidth, type Look, type Mounted, type Placed, type ScreenSize, splitWidth, tabsTitle } from "@tui-dash/ui";
import { type Cell, type Layout, type Row, type Slot, slotPanels, type Wide } from "./layout";

export interface Member {
  readonly id: string;
  readonly mounted: Mounted;
}

// A lone panel is a group of one tab, which draws without a row of names.
export interface Group {
  readonly key: string;
  readonly members: readonly [Member, ...Member[]];
}

interface Rows {
  readonly least: number | undefined;
  readonly cells: ReadonlyArray<BoardCell>;
}

interface BoardCell {
  readonly share: number;
  readonly groups: ReadonlyArray<Group>;
}

type BoardRow = (Rows & { readonly height: "auto"; readonly atMost: number }) | (Rows & { readonly height: "fill" });

export interface BoardWide {
  readonly atLeast: { readonly columns: number; readonly rows: number };
  readonly rows: ReadonlyArray<BoardRow>;
}

export interface Board {
  readonly wide: ReadonlyArray<BoardWide>;
  readonly narrow: ReadonlyArray<Member>;
  readonly narrowGivesWay: ReadonlyArray<string>;
}

const groupOf = (slot: Slot | Cell, mounted: ReadonlyMap<string, Mounted>): ReadonlyArray<Group> => {
  const members = slotPanels(slot).flatMap((id) => {
    const found = mounted.get(id);
    return found === undefined ? [] : [{ id, mounted: found }];
  });
  const first = members.at(0);
  return first === undefined ? [] : [{ key: members.map((member) => member.id).join("|"), members: [first, ...members.slice(1)] }];
};

const cellOf = (cell: Cell, mounted: ReadonlyMap<string, Mounted>): ReadonlyArray<BoardCell> => {
  const groups = "stack" in cell ? cell.stack.flatMap((slot) => groupOf(slot, mounted)) : groupOf(cell, mounted);
  return groups.length === 0 ? [] : [{ share: cell.width ?? 1, groups }];
};

const rowOf = (row: Row, mounted: ReadonlyMap<string, Mounted>): ReadonlyArray<BoardRow> => {
  const cells = row.cells.flatMap((cell) => cellOf(cell, mounted));
  if (cells.length === 0) return [];
  return row.height === "auto" ? [{ height: "auto", atMost: row.atMost ?? 1, least: row.least, cells }] : [{ height: "fill", least: row.least, cells }];
};

const wideOf = (wide: Wide, mounted: ReadonlyMap<string, Mounted>): ReadonlyArray<BoardWide> => {
  const rows = wide.rows.flatMap((row) => rowOf(row, mounted));
  return rows.length === 0 ? [] : [{ atLeast: wide.atLeast, rows }];
};

// A panel the layout names but nobody mounted leaves no gap: its tab, cell or row closes up.
export const boardOf = (layout: Layout, mounted: ReadonlyMap<string, Mounted>): Board => ({
  wide: layout.wide.flatMap((wide) => wideOf(wide, mounted)),
  narrow: layout.narrow.flatMap((id) => {
    const found = mounted.get(id);
    return found === undefined ? [] : [{ id, mounted: found }];
  }),
  narrowGivesWay: layout.narrowGivesWay,
});

export const wideFor = (board: Board, size: ScreenSize): BoardWide | undefined =>
  board.wide.find((wide) => size.columns >= wide.atLeast.columns && size.rows >= wide.atLeast.rows);

export const wideMembers = (wide: BoardWide): ReadonlyArray<Member> =>
  wide.rows.flatMap((row) => row.cells.flatMap((cell) => cell.groups.flatMap((group) => group.members)));

export interface BoardView {
  readonly placedOf: (member: Member) => Placed;
  readonly openOf: (group: Group) => Member;
  readonly lit: (member: Member) => boolean;
  // Unset at home, where no box widens over its row.
  readonly focus: string | undefined;
}

type RowsOf = (placed: Placed, width: number) => number;

const naturalRows: RowsOf = (placed, width) => placed.natural(width);

const leastRows: RowsOf = (placed, width) => placed.least(width);

const badged = (view: BoardView, members: ReadonlyArray<Member>): ReadonlyArray<Member> =>
  members.filter((member) => view.placedOf(member).badge !== undefined);

// Every tab is measured with the badges its shut neighbours leave under it, so switching tabs never moves the boxes around it.
const groupRows = (view: BoardView, group: Group, width: number, rowsOf: RowsOf): number =>
  Math.max(...group.members.map((member) => rowsOf(view.placedOf(member), width) + badged(view, group.members.filter((other) => other !== member)).length));

const cellRows = (view: BoardView, cell: BoardCell, width: number, rowsOf: RowsOf): number =>
  cell.groups.reduce((sum, group) => sum + groupRows(view, group, width, rowsOf), 0);

const sum = (values: ReadonlyArray<number>): number => values.reduce((total, value) => total + value, 0);

const cellWidths = (cells: ReadonlyArray<BoardCell>, width: number): ReadonlyArray<number> => {
  const units = splitWidth(width, sum(cells.map((cell) => cell.share)));
  return cells.map((cell, index) => {
    const from = sum(cells.slice(0, index).map((before) => before.share));
    return sum(units.slice(from, from + cell.share));
  });
};

// An auto row is capped and its stacks give way from the top, so a box below the first counts at its least; at its natural a row of tabs would leave its shorter tabs over blank rows.
const autoCellRows = (view: BoardView, cell: BoardCell, width: number): number =>
  cell.groups.reduce((total, group, index) => total + groupRows(view, group, width, index === 0 ? naturalRows : leastRows), 0);

interface Placing {
  readonly cell: BoardCell;
  readonly width: number;
}

// The focused box's full width in the row, when its share of the row is narrower than that.
const grownWidth = (view: BoardView, cell: BoardCell, width: number, row: number): number | undefined =>
  cell.groups
    .map((group) => view.openOf(group))
    .filter((open) => open.id === view.focus)
    .map((open) => Math.min(row, view.placedOf(open).fullWidth?.(row) ?? 0))
    .find((full) => full > width);

// A grown cell leaves the rest of the row to the other cells, and takes all of it when the rest could not hold a box.
const placings = (view: BoardView, row: BoardRow, width: number): ReadonlyArray<Placing> => {
  const widths = cellWidths(row.cells, width);
  const shared = row.cells.map((cell, index) => ({ cell, width: widths.at(index) ?? 0 }));
  for (const placing of shared) {
    const full = grownWidth(view, placing.cell, placing.width, width);
    if (full === undefined) continue;
    const rest = width - full;
    if (rest < leastPanelWidth) return [{ cell: placing.cell, width }];
    const others = row.cells.filter((cell) => cell !== placing.cell);
    const otherWidths = cellWidths(others, rest);
    return row.cells.map((cell) => ({ cell, width: cell === placing.cell ? full : (otherWidths.at(others.indexOf(cell)) ?? 0) }));
  }
  return shared;
};

const rowMeasure = (view: BoardView, row: BoardRow, width: number) => {
  const placed = placings(view, row, width);
  const each = (rowsOf: (cell: BoardCell, width: number) => number) => Math.max(...placed.map((placing) => rowsOf(placing.cell, placing.width)));
  const natural = row.height === "auto" ? each((cell, cellWidth) => autoCellRows(view, cell, cellWidth)) : each((cell, cellWidth) => cellRows(view, cell, cellWidth, naturalRows));
  return { natural, least: row.least ?? each((cell, cellWidth) => cellRows(view, cell, cellWidth, leastRows)) };
};

// An auto row takes its natural height up to its share of the screen, and the fill rows split what is left.
const rowHeights = (view: BoardView, rows: ReadonlyArray<BoardRow>, width: number, screenRows: number): ReadonlyArray<number> => {
  const measures = rows.map((row) => rowMeasure(view, row, width));
  if (!Number.isFinite(screenRows)) return measures.map((measure) => measure.natural);
  const fillLeast = sum(rows.map((row, index) => (row.height === "fill" ? (measures.at(index)?.least ?? 0) : 0)));
  if (sum(measures.map((measure) => measure.least)) > screenRows) return measures.map((measure) => measure.least);
  const autoBudget = Math.max(0, screenRows - fillLeast);
  const autos = new Array<number>(rows.length).fill(0);
  let autoUsed = 0;
  rows.forEach((row, index) => {
    if (row.height !== "auto") return;
    const measure = measures.at(index);
    if (measure === undefined) return;
    const laterLeast = sum(rows.slice(index + 1).map((rest, offset) => (rest.height === "auto" ? (measures.at(index + 1 + offset)?.least ?? 0) : 0)));
    const want = Math.max(measure.least, Math.min(measure.natural, Math.floor(screenRows * row.atMost)));
    const take = Math.min(want, Math.max(measure.least, autoBudget - autoUsed - laterLeast));
    autos[index] = take;
    autoUsed += take;
  });
  const remaining = Math.max(0, screenRows - autoUsed);
  const fillRows = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.height === "fill");
  const shares = splitWidth(remaining, fillRows.length);
  const takes = fillRows.map(({ index }, order) => Math.max(measures.at(index)?.least ?? 0, shares.at(order) ?? 0));
  let overflow = sum(autos) + sum(takes) - screenRows;
  const adjustable = takes.map((take, order) => ({ order, index: fillRows.at(order)?.index ?? 0, take })).sort((left, right) => right.take - left.take);
  for (const slot of adjustable) {
    if (overflow <= 0) break;
    const least = measures.at(slot.index)?.least ?? 0;
    const give = Math.min(overflow, slot.take - least);
    if (give <= 0) continue;
    takes[slot.order] = slot.take - give;
    overflow -= give;
  }
  let fillOrder = 0;
  return rows.map((row, index) => {
    if (row.height === "auto") return autos.at(index) ?? 0;
    const take = takes.at(fillOrder) ?? 0;
    fillOrder += 1;
    return take;
  });
};

// Each group above the last takes its natural height while the groups below it keep their least, and the last takes the rest.
const stackHeights = (view: BoardView, groups: ReadonlyArray<Group>, width: number, height: number): ReadonlyArray<number> => {
  let used = 0;
  return groups.map((group, index) => {
    if (index === groups.length - 1) return Math.max(0, height - used);
    const below = sum(groups.slice(index + 1).map((rest) => groupRows(view, rest, width, leastRows)));
    const rows = Math.min(groupRows(view, group, width, naturalRows), Math.max(groupRows(view, group, width, leastRows), height - used - below));
    used += rows;
    return rows;
  });
};

export interface Part {
  readonly group: Group;
  readonly x: number;
  readonly y: number;
  readonly size: ScreenSize;
}

export interface PlannedRow {
  readonly height: number;
  readonly cells: ReadonlyArray<{ readonly width: number; readonly parts: ReadonlyArray<Part> }>;
}

export const planOf = (view: BoardView, wide: BoardWide, size: ScreenSize): ReadonlyArray<PlannedRow> => {
  const heights = rowHeights(view, wide.rows, size.columns, size.rows);
  let y = 0;
  return wide.rows.map((row, rowIndex) => {
    const height = heights.at(rowIndex) ?? 0;
    let x = 0;
    const cells = placings(view, row, size.columns).map(({ cell, width }) => {
      let top = y;
      const heightsOf = stackHeights(view, cell.groups, width, height);
      const parts = cell.groups.map((group, groupIndex) => {
        const rows = heightsOf.at(groupIndex) ?? 0;
        const part = { group, x, y: top, size: { columns: width, rows } };
        top += rows;
        return part;
      });
      x += width;
      return { width, parts };
    });
    y += height;
    return { height, cells };
  });
};

const cadenceMillis = (member: Member): number => Duration.toMillis(Duration.fromInputUnsafe(member.mounted.cadence));

export const readSince = (member: Member, live: boolean): number | undefined => {
  if (!live) return undefined;
  const fresh = member.mounted.freshness();
  // The box shows every dependency it tracks, so its age is the oldest one of them.
  return fresh.length === 0 ? undefined : Math.min(...fresh.map((entry) => entry.at));
};

export const refreshing = (member: Member, live: boolean): boolean => live && member.mounted.refreshing();

export const savedOnly = (member: Member): boolean => {
  const fresh = member.mounted.freshness();
  return fresh.length > 0 && fresh.every((entry) => entry.kind === "saved");
};

export const savedSince = (member: Member): Freshness | undefined => savedAtOf(member.mounted.freshness());

// A row of tabs reads as often as its fastest tab, so the title names that cadence.
export const lookOf = (view: BoardView, group: Group, width: number): { readonly member: Member; readonly look: Look } => {
  const member = view.openOf(group);
  const shut = group.members.filter((other) => other !== member);
  const below = badged(view, shut).flatMap((other) => {
    const badge = view.placedOf(other).badge;
    return badge === undefined ? [] : [badge(width)];
  });
  const fastest = group.members.reduce((best, other) => (cadenceMillis(other) < cadenceMillis(best) ? other : best));
  const tabs = group.members.map((other) => ({ name: other.mounted.name, key: other.mounted.key }));
  const title = group.members.length > 1 ? tabsTitle(tabs, member.mounted.name, everyText(fastest.mounted.cadence), width) : undefined;
  return { member, look: { focused: view.lit(member), title, below, alone: false } };
};
