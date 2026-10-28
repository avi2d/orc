import type { DateTime } from "effect";
import { readsCadence } from "@tui-dash/schema";
import { type Block, everyText, focusFrame, frameRows, type Look, panelChrome, panelled, restFrame, singleTitle, span, type Tone } from "@tui-dash/ui";
import type { LedgerFeed } from "./conversation";
import { fullHints, heightsOf, ledgerFull, ledgerShown, ledgerTitle, type SaidMessage, windowOf } from "./ledger";

export interface LedgerReadings {
  readonly sessions: LedgerFeed["sessions"] | "pending";
  readonly ledger: ReadonlyArray<SaidMessage>;
  readonly now: DateTime.Utc;
  readonly zone: DateTime.TimeZone;
}

// The open message stays open while the cursor moves on, so a detail keeps its place.
export interface LedgerPick {
  readonly row: string | undefined;
  readonly open: string | undefined;
  readonly scroll: number;
  readonly line: number;
  readonly full: boolean;
}

export const closedPick: LedgerPick = { row: undefined, open: undefined, scroll: 0, line: 0, full: false };

// A click on the compact box takes the full screen with the cursor on that message.
export const openedAt = (row: string | undefined): LedgerPick => ({ row, open: undefined, scroll: 0, line: 0, full: true });

export interface LedgerColumn {
  readonly block: Block;
  // Each row is counted from the box's top edge.
  readonly targets: ReadonlyArray<{ readonly row: number; readonly open: LedgerPick }>;
}

export interface LedgerBox {
  readonly width: number;
  readonly height: number;
}

export const ledgerIdsInBox = (readings: LedgerReadings, box: LedgerBox, below = 0): ReadonlyArray<string> => {
  const room = Math.max(0, box.height - frameRows - below);
  const shown = ledgerShown(readings.ledger, readings.now, box.width - panelChrome, room, undefined, undefined);
  return shown.rows.map((line) => line.id);
};

// A cursor on a message the box no longer shows would steer from somewhere the reader cannot see.
export const clampLedgerInBox = (readings: LedgerReadings, pick: LedgerPick, box: LedgerBox, below = 0): LedgerPick => {
  if (pick.full || pick.row === undefined) return pick;
  return ledgerIdsInBox(readings, box, below).includes(pick.row) ? pick : closedPick;
};

const samePick = (left: LedgerPick, right: LedgerPick): boolean =>
  left.row === right.row && left.open === right.open && left.scroll === right.scroll && left.line === right.line && left.full === right.full;

export const openScrollRoom = (readings: LedgerReadings, open: string | undefined, width: number, height: number): { readonly available: number; readonly ceiling: number } => {
  const inner = Math.max(0, width - panelChrome);
  const room = Math.max(0, height - frameRows - 1);
  const heights = heightsOf(readings.ledger, readings.zone, inner, open);
  const at = open === undefined ? -1 : readings.ledger.findIndex((message) => message.id === open);
  if (at < 0) return { available: room, ceiling: 0 };
  const block = (heights[at] ?? 1) - 1;
  const available = Math.max(0, room - (at > 0 ? 1 : 0));
  return { available, ceiling: Math.max(0, block - available) };
};

// The full screen scrolls the window so the cursor stays in sight, landing on the newest message when it opens.
export const clampLedgerFull = (readings: LedgerReadings, pick: LedgerPick, width: number, height: number): LedgerPick => {
  const ids = readings.ledger.map((message) => message.id);
  const row = pick.row !== undefined && ids.includes(pick.row) ? pick.row : ids.at(-1);
  const open = pick.open !== undefined && ids.includes(pick.open) ? pick.open : undefined;
  const inner = Math.max(0, width - panelChrome);
  const room = Math.max(0, height - frameRows - 1);
  const heights = heightsOf(readings.ledger, readings.zone, inner, open);
  const cursor = Math.max(0, row === undefined ? readings.ledger.length - 1 : ids.indexOf(row));
  const { top } = windowOf(heights, room, pick.scroll, cursor);
  const { ceiling } = openScrollRoom(readings, open, width, height);
  const line = open === undefined ? 0 : Math.max(0, Math.min(pick.line, ceiling));
  const clamped = { row, open, scroll: top, line, full: true };
  return samePick(pick, clamped) ? pick : clamped;
};

const emptyText: Record<LedgerReadings["sessions"], string> = {
  pending: "reading the ledger\u2026",
  unset: "TUI_DASH_LEDGER_SESSIONS is unset, so no messages show",
  set: "no messages today",
};

const emptyLine = (readings: LedgerReadings): Block => [[span(emptyText[readings.sessions], "muted")]];

export const ledgerNatural = (readings: LedgerReadings): number => (readings.ledger.length === 0 ? 1 : readings.ledger.length) + frameRows;

export const ledgerColumn = (readings: LedgerReadings, pick: LedgerPick, look: Look, width: number, height: number): LedgerColumn => {
  const frame = look.focused ? focusFrame : restFrame;
  const title = singleTitle(ledgerTitle, everyText(readsCadence), width, look.focused, "l");
  const tone: Tone | undefined = pick.row === undefined ? undefined : look.focused ? "pick" : "held";
  const shown = ledgerShown(readings.ledger, readings.now, width - panelChrome, Math.max(0, height - frameRows - look.below.length), pick.row, tone);
  const lines = shown.lines.length === 0 ? emptyLine(readings) : shown.lines;
  return {
    block: panelled(look.title ?? title, [...lines, ...look.below], width, height, frame),
    targets: shown.rows.map((row) => ({ row: 1 + row.line, open: openedAt(row.id) })),
  };
};

export const ledgerFullColumn = (readings: LedgerReadings, pick: LedgerPick, width: number, height: number): LedgerColumn => {
  const title = singleTitle(ledgerTitle, everyText(readsCadence), width);
  const inner = Math.max(0, width - panelChrome);
  const room = Math.max(0, height - frameRows - 1);
  const full = ledgerFull(readings.ledger, readings.zone, inner, room, pick.row, pick.open, pick.scroll, pick.line);
  const lines: Block = full.lines.length === 0 ? (room === 0 ? [] : emptyLine(readings)) : full.lines;
  const padded = [...lines, ...Array.from({ length: Math.max(0, room - lines.length) }, (): Array<never> => [])];
  return {
    block: panelled(title, [...padded, fullHints(inner)], width, height, focusFrame),
    targets: full.rows.map((row) => ({
      row: 1 + row.line,
      open: { ...pick, row: row.id, open: pick.open === row.id ? undefined : row.id, scroll: full.top, line: 0 },
    })),
  };
};
