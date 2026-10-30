import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { plain } from "@tui-dash/ui";
import { bandedReadings } from "../../lib/banded-fixture";
import { bandedLines, bandedScreen, type Step } from "../../lib/host-fixture";

const frameOf = (columns: number, rows: number, steps: ReadonlyArray<Step>): string => bandedLines(columns, rows, steps).join("\n");

const recorded = (name: string): Promise<string> => Bun.file(join(import.meta.dir, "..", "..", "fixtures", "dashboard-host", `${name}.txt`)).text();

describe("the host draws the banded dashboard's frames from its layout", () => {
  const cases: ReadonlyArray<readonly [string, number, number, ReadonlyArray<Step>]> = [
    ["84x24-start", 84, 24, []],
    ["84x60-ledger-out", 84, 60, [{ press: "l" }, { move: "out" }]],
    ["119x50-in-down-in", 119, 50, [{ move: "in" }, { move: "down" }, { move: "in" }]],
    ["120x36-start", 120, 36, []],
    ["120x36-in-down-in", 120, 36, [{ move: "in" }, { move: "down" }, { move: "in" }]],
    ["120x40-alerts", 120, 40, [{ press: "a" }]],
    ["160x48-in", 160, 48, [{ move: "in" }]],
    ["160x48-scheduled", 160, 48, [{ press: "s" }]],
    ["240x36-start", 240, 36, []],
    ["240x36-home-down", 240, 36, [{ move: "down" }]],
    ["240x60-in-in-in", 240, 60, [{ move: "in" }, { move: "in" }, { move: "in" }]],
    ["240x60-ledger-down-in", 240, 60, [{ press: "l" }, { move: "down" }, { move: "in" }]],
  ];
  for (const [name, columns, rows, steps] of cases) {
    test(name, async () => {
      expect(frameOf(columns, rows, steps)).toBe(await recorded(name));
    });
  }

  test("a shut tab's badge stays inside the open tasks frame", () => {
    const tabs = {
      wide: [{ atLeast: { columns: 80, rows: 4 }, rows: [{ height: "fill", cells: [{ tabs: ["tasks", "session-quota"] }] }] }],
      narrow: ["tasks", "session-quota"],
    };
    const screen = bandedScreen(bandedReadings(), tabs);
    const drawn = screen.draw(0, screen.initial, 120, 40);
    const lines = drawn.block.map(plain);
    expect(lines).toHaveLength(40);
    const badge = lines.findIndex((line) => line.includes("gluttons:"));
    expect(badge).toBeGreaterThan(-1);
    expect(lines.at(badge)?.startsWith("\u2502")).toBe(true);
    expect(lines.at(badge)?.endsWith("\u2502")).toBe(true);
    expect(badge).toBeLessThan(lines.length - 1);
    expect(lines.at(-1)).toMatch(/^[\u2514\u2570].*[\u2518\u256F]$/u);
  });
});
