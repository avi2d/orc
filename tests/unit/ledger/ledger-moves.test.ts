import { describe, expect, test } from "bun:test";
import { clampLedgerInBox, closedPick, ledgerIdsInBox, type LedgerPick, ledgerMoved, ledgerPlaced, type LedgerReadings, openedAt } from "@tui-dash/ledger";
import { type Block, plain, type ScreenSize } from "@tui-dash/ui";
import { bandedReadings } from "../../lib/banded-fixture";
import { dashboardNow } from "../../lib/dashboard-fixture";

const readingsOf = (banded = bandedReadings()): LedgerReadings => ({ sessions: "set", ledger: banded.ledger, now: banded.now, zone: banded.tasks.zone });

const screen: ScreenSize = { columns: 120, rows: 36 };

const wholeOf = (readings: LedgerReadings, pick: LedgerPick, size: ScreenSize = screen): Block => ledgerPlaced(() => readings, pick).whole?.(size)?.block ?? [];

const pickedIn = (block: Block): ReadonlyArray<string> => block.filter((line) => line.some((part) => part.style.background === "pick")).map(plain);

// Oracle: the ledger's key table, where l takes the full screen on the newest message and a second l steps back,
// ↑↓ walk the messages, ⏎ folds a message open and shut while the cursor moves on, pgup pgdn cross a screen of them,
// and esc steps back to the compact box. Rejects an open message lost on a cursor move, a close that leaves the full screen,
// and a cursor stored on the newest message so a later arrival goes unpicked.
// An unset cursor steps from the newest message, as the screen settled it before any move.
describe("the ledger's moves", () => {
  const readings = readingsOf();
  const full: LedgerPick = openedAt(undefined);
  const on = (row: string): LedgerPick => ({ ...full, row });

  test("l takes the full screen on the newest message and a second l steps back", () => {
    const placed = ledgerPlaced(() => readings).press?.("l", screen);
    const opened = placed?.whole?.(screen);
    expect(opened?.block.at(0) === undefined ? "" : plain(opened.block.at(0) ?? [])).toContain("ledger \u00b7 today");
    expect(placed?.press?.("l", screen).whole?.(screen)).toBeUndefined();
  });

  test("l highlights the newest message and follows new arrivals without storing the cursor", () => {
    const picked = pickedIn(wholeOf(readings, full));
    expect(picked).toHaveLength(1);
    expect(picked.join("\n")).toContain("takes the full screen");
    const arrived = { id: "m-late", at: dashboardNow, who: { role: "you" as const }, text: "late arrival" };
    const repicked = pickedIn(wholeOf({ ...readings, ledger: [...readings.ledger, arrived] }, full));
    expect(repicked).toHaveLength(1);
    expect(repicked.join("\n")).toContain("late arrival");
  });

  test("keeps the hints with no room for messages on a three-row screen", () => {
    const text = wholeOf({ ...readings, ledger: [] }, on("m-full"), { columns: 120, rows: 3 }).map(plain).join("\n");
    expect(text).toContain("esc back");
    expect(text).not.toContain("no messages today");
  });

  // Oracle: the README's ledger settings, where the ledger stays empty while TUI_DASH_LEDGER_SESSIONS is unset, and the
  // tasks panel's wording for its own unset report. Rejects an unset folder drawn as a quiet day.
  test("names the unset sessions folder instead of claiming a quiet day", () => {
    const textOf = (sessions: LedgerReadings["sessions"]): string => wholeOf({ ...readings, sessions, ledger: [] }, full).map(plain).join("\n");
    expect(textOf("unset")).toContain("TUI_DASH_LEDGER_SESSIONS is unset, so no messages show");
    expect(textOf("unset")).not.toContain("no messages today");
    expect(textOf("set")).toContain("no messages today");
  });

  test("walk the messages newest-first, open one on the way in and fold it shut on the way in again", () => {
    expect(ledgerMoved(readings, full, "down", screen)?.row).toBe("m-full");
    expect(ledgerMoved(readings, full, "up", screen)?.row).toBe("m-ask");
    const open = ledgerMoved(readings, on("m-full"), "in", screen);
    expect(open).toEqual({ row: "m-full", open: "m-full", scroll: 0, line: 0, full: true });
    if (open === undefined) return;
    expect(ledgerMoved(readings, open, "up", screen)).toEqual({ row: "m-ask", open: "m-full", scroll: 0, line: 0, full: true });
    expect(ledgerMoved(readings, { ...open, row: "m-ask" }, "in", screen)?.open).toBe("m-ask");
    expect(ledgerMoved(readings, open, "out", screen)).toMatchObject({ full: false });
  });

  // Seven rows leave room for two folded messages under the frame and the hints row.
  test("cross a screen of messages on pgup pgdn", () => {
    const short = { columns: 120, rows: 7 };
    expect(ledgerMoved(readings, on("m-full"), "pageup", short)?.row).toBe("m-plan");
    expect(ledgerMoved(readings, on("m-early"), "pagedown", short)?.row).toBe("m-ask");
  });

  test("compact selection counts the shut tab badge rows with the rendering", () => {
    const box = { width: 120, height: 6 };
    expect(ledgerIdsInBox(readings, box, 1)).toEqual(["m-ask", "m-full"]);
    expect(ledgerMoved(readings, closedPick, "down", { columns: 120, rows: 6 }, 1)?.row).toBe("m-ask");
    expect(clampLedgerInBox(readings, { ...closedPick, row: "m-early" }, box, 1)).toEqual(closedPick);
  });

  test("hand the focus back on a step out of the compact box", () => {
    expect(ledgerMoved(readings, closedPick, "out", screen)).toBeUndefined();
  });

  test("read the conversation newest-last with the full text of the open message on a 120 column screen", () => {
    const lines = wholeOf(readings, { ...on("m-full"), open: "m-full" }, { columns: 120, rows: 40 }).map(plain);
    expect(lines.at(0)).toContain("ledger \u00b7 today");
    const text = lines.join("\n");
    expect(text).toContain("15:18 you Ship the ledger board today.");
    expect(text).toContain("19:53 assistant Yes. l takes the full screen, and the cursor opens");
    expect(text).toContain("its wrapped words stay readable beside the time.");
    expect(text).toContain("\u2191\u2193 move \u23ce or click open pgup pgdn page l or esc back");
  });
});
