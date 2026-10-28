import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import { plain } from "@tui-dash/ui";
import { bandedReadings } from "../../lib/banded-fixture";
import { bandedDrawn, bandedScreen, stepped } from "../../lib/host-fixture";

const size = { columns: 120, rows: 36 };

// The compact box carries the same title, so only the full screen starts its first line with it.
const holdsScreen = (columns: number, rows: number, state = bandedScreen().initial): boolean => {
  const line = bandedScreen().draw(0, state, columns, rows).block.at(0);
  return line !== undefined && plain(line).startsWith("\u256d\u2500 ledger \u00b7 today");
};

describe("the dashboard's ledger", () => {
  const screen = bandedScreen();

  test("starts in the compact box", () => {
    expect(holdsScreen(size.columns, size.rows)).toBe(false);
  });

  test("takes the full screen with the focus on l and steps back on a second l", () => {
    const opened = stepped(screen, size, [{ press: "l" }]);
    expect(opened.focus).toBe("ledger");
    expect(holdsScreen(size.columns, size.rows, opened)).toBe(true);
    const back = stepped(screen, size, [{ press: "l" }], opened);
    expect(holdsScreen(size.columns, size.rows, back)).toBe(false);
  });

  test("opens nothing beside the screen from the ledger", () => {
    const opened = stepped(screen, size, [{ press: "l" }, { move: "in" }]);
    expect(screen.link?.(0, opened, size)).toBeUndefined();
  });

  test("opens the full screen from a click on a compact row", () => {
    const target = bandedDrawn(120, 40).targets.find((row) => row.state.focus === "ledger" && holdsScreen(120, 40, row.state));
    expect(target).toBeDefined();
  });

  test("a clipped compact box keeps no click target on its summary row", () => {
    const recorded = bandedReadings();
    const ledger = [
      ...recorded.ledger,
      { id: "m-late", at: DateTime.makeUnsafe("2026-10-13T20:00:00Z"), who: { role: "you" as const }, text: "Late note one." },
      { id: "m-later", at: DateTime.makeUnsafe("2026-10-13T20:05:00Z"), who: { role: "agent" as const, name: "assistant" }, text: "Late note two." },
    ];
    const solo = {
      wide: [{ atLeast: { columns: 80, rows: 4 }, rows: [{ height: "fill", least: 8, cells: [{ panel: "ledger" }] }] }],
      narrow: ["ledger"],
    };
    const small = bandedScreen({ ...recorded, ledger }, solo);
    const drawn = small.draw(0, small.initial, 120, 5);
    expect(drawn.block.length).toBe(5);
    const summary = drawn.block.findIndex((line) => /^\+\d+ more rows/.test(plain(line)));
    expect(summary).toBe(4);
    expect(drawn.targets.length).toBeGreaterThan(0);
    expect(drawn.targets.every((target) => target.row < summary)).toBe(true);
  });
});
