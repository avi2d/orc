import { frameRows, type Move, type ScreenSize } from "@tui-dash/ui";
import { clampLedgerFull, clampLedgerInBox, type LedgerPick, ledgerIdsInBox, type LedgerReadings, openedAt, openScrollRoom } from "./ledger-column";

// The size is the full screen while the pick is full, and the compact box otherwise.
const clamped = (readings: LedgerReadings, pick: LedgerPick, size: ScreenSize, below = 0): LedgerPick =>
  pick.full ? clampLedgerFull(readings, pick, size.columns, size.rows) : clampLedgerInBox(readings, pick, { width: size.columns, height: size.rows }, below);

const shownIds = (readings: LedgerReadings, pick: LedgerPick, size: ScreenSize, below = 0): ReadonlyArray<string> =>
  pick.full ? readings.ledger.map((message) => message.id) : ledgerIdsInBox(readings, { width: size.columns, height: size.rows }, below);

// A page crosses the messages one screen holds at once, so the full screen counts its room and the box its rows.
const spanOf = (readings: LedgerReadings, pick: LedgerPick, size: ScreenSize, below = 0): number =>
  pick.full ? Math.max(1, Math.floor(Math.max(0, size.rows - frameRows - 1) / 2)) : Math.max(1, shownIds(readings, pick, size, below).length);

const by = (rows: ReadonlyArray<string>, pick: LedgerPick, step: number): LedgerPick => {
  const first = rows.at(0);
  if (first === undefined) return pick;
  if (pick.row === undefined) return { ...pick, row: first };
  const next = rows.at(Math.min(rows.length - 1, Math.max(0, rows.indexOf(pick.row) + step)));
  return next === undefined || next === pick.row ? pick : { ...pick, row: next };
};

const stepOf = (move: Move, span: number): number | undefined => {
  switch (move) {
    case "up":
      return -1;
    case "down":
      return 1;
    case "pageup":
      return -span;
    case "pagedown":
      return span;
    case "in":
    case "out":
      return undefined;
  }
};

// An open message taller than the screen scrolls its own lines before the cursor leaves it.
const scrolledOpen = (readings: LedgerReadings, pick: LedgerPick, step: number, size: ScreenSize): LedgerPick | undefined => {
  if (!pick.full || pick.open === undefined || pick.row !== pick.open) return undefined;
  const { available, ceiling } = openScrollRoom(readings, pick.open, size.columns, size.rows);
  if (available <= 0 || ceiling <= 0) return undefined;
  const line = Math.max(0, Math.min(ceiling, pick.line + step));
  return line === pick.line ? undefined : { ...pick, line };
};

const steppedInner = (readings: LedgerReadings, pick: LedgerPick, move: Move, size: ScreenSize, below = 0): LedgerPick | undefined => {
  const step = stepOf(move, spanOf(readings, pick, size, below));
  if (step !== undefined) return scrolledOpen(readings, pick, step, size) ?? by(shownIds(readings, pick, size, below), pick, step);
  if (!pick.full) return move === "in" ? pick : undefined;
  if (move === "out") return { ...pick, full: false, line: 0 };
  const row = pick.row ?? readings.ledger.at(-1)?.id;
  if (row === undefined) return pick;
  return { ...pick, row, open: pick.open === row ? undefined : row, line: 0 };
};

// Undefined hands the focus back: a step out of the compact box.
export const ledgerMoved = (readings: LedgerReadings, pick: LedgerPick, move: Move, size: ScreenSize, below = 0): LedgerPick | undefined => {
  const stepped = steppedInner(readings, clamped(readings, pick, size, below), move, size, below);
  return stepped === undefined ? undefined : clamped(readings, stepped, size, below);
};

export const ledgerToggled = (pick: LedgerPick): LedgerPick => (pick.full ? { ...pick, full: false, line: 0 } : openedAt(undefined));

export const ledgerSettled = (pick: LedgerPick): LedgerPick => (!pick.full && pick.line === 0 ? pick : { ...pick, full: false, line: 0 });
