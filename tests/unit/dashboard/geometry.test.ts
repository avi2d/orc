import { describe, expect, test } from "bun:test";
import { plain, quotaLines } from "@avi2dg/orc-quota";
import { taskLevels } from "@avi2dg/orc-schema";
import { panelWidth, widthOf } from "@avi2dg/orc-ui";
import { type BandedReadings, bandedReadings } from "../../lib/banded-fixture";
import { dashboardNow, quotaBlocksOf } from "../../lib/dashboard-fixture";
import { fixture } from "../../lib/fixtures";
import { cadencesOffTheRight, lonelyWords, pastTheRightEdge, type Screen, screenOf, sharedCells, textOverFrames } from "../../lib/geometry";
import { bandedLines, type Step } from "../../lib/host-fixture";
import { orcQuotaText } from "../../lib/orc-quota";
import { taskReadings } from "../../lib/task-levels-fixture";

const widths = Array.from({ length: 161 }, (_, index) => 80 + index);

const banded = bandedReadings();

const unsetLevels = taskLevels({ ...taskReadings({ tasks: { kind: "unset" } }), interval: "all" });

const unsetTasks: BandedReadings = { ...banded, tasks: { ...banded.tasks, levels: unsetLevels, byMachine: new Map([["north", unsetLevels]]) } };

interface Shown {
  readonly name: string;
  readonly rows: number;
  readonly steps: ReadonlyArray<Step>;
  readonly readings: BandedReadings;
}

const shown: ReadonlyArray<Shown> = [
  { name: "home", rows: 24, steps: [], readings: banded },
  { name: "home", rows: 40, steps: [], readings: banded },
  { name: "home", rows: 60, steps: [], readings: banded },
  { name: "home with no tasks report", rows: 40, steps: [], readings: unsetTasks },
  { name: "alerts tab", rows: 40, steps: [{ press: "a" }], readings: banded },
  { name: "scheduled tab", rows: 40, steps: [{ press: "s" }], readings: banded },
  { name: "projects", rows: 40, steps: [{ press: "p" }], readings: banded },
  { name: "projects with no tasks report", rows: 40, steps: [{ press: "p" }], readings: unsetTasks },
  { name: "a project's tasks", rows: 40, steps: [{ press: "p" }, { move: "in" }, { move: "in" }], readings: banded },
  { name: "ledger", rows: 40, steps: [{ press: "l" }], readings: banded },
  { name: "an open message", rows: 40, steps: [{ press: "l" }, { move: "in" }], readings: banded },
];

const drawnAt = new Map<number, ReadonlyArray<readonly [string, Screen]>>();

// Every rule reads the same screens, so each width draws them once.
const screensAt = (columns: number): ReadonlyArray<readonly [string, Screen]> => {
  const known = drawnAt.get(columns);
  if (known !== undefined) return known;
  const drawn = shown.map(({ name, rows, steps, readings }) => [`${name} at ${columns}x${rows}`, screenOf(bandedLines(columns, rows, steps, readings), columns)] as const);
  drawnAt.set(columns, drawn);
  return drawn;
};

const problemsAt = (columns: number, rule: (screen: Screen) => ReadonlyArray<string>): ReadonlyArray<string> =>
  screensAt(columns).flatMap(([name, screen]) => rule(screen).map((problem) => `${name}: ${problem}`));

// The first rule at a width draws every screen synchronously, which no timeout can cut short, so a limit here only fails a loaded host.
const drawLimitMillis = 30_000;

describe("the dashboard's layout rules hold at every width from 80 to 240 columns", () => {
  test.each(widths)("no row runs past the right edge at %d columns", (columns) => {
    expect(problemsAt(columns, pastTheRightEdge)).toEqual([]);
  }, drawLimitMillis);

  test.each(widths)("no two boxes share a cell at %d columns", (columns) => {
    expect(problemsAt(columns, sharedCells)).toEqual([]);
  }, drawLimitMillis);

  test.each(widths)("no text writes over a border or corner at %d columns", (columns) => {
    expect(problemsAt(columns, textOverFrames)).toEqual([]);
  }, drawLimitMillis);

  test.each(widths)("no refresh cadence sits away from the right end of its title at %d columns", (columns) => {
    expect(problemsAt(columns, cadencesOffTheRight)).toEqual([]);
  }, drawLimitMillis);

  test.each(widths)("no word wraps alone onto a line of its own at %d columns", (columns) => {
    expect(problemsAt(columns, lonelyWords)).toEqual([]);
  }, drawLimitMillis);
});

describe("each layout rule rejects the defect it names", () => {
  const columns = 60;
  const edge = (start: string, end: string): string => start + "─".repeat(columns - widthOf(start) - widthOf(end)) + end;
  const box = (top: string, rows: ReadonlyArray<string>, bottom: string) =>
    screenOf([top, ...rows.map((row) => `│ ${row.padEnd(columns - 4)} │`), bottom], columns);
  const titled = edge("╭─ tasks ", " ↻ 2s ─╮");
  const closed = edge("╰", "╯");

  test("key hints cut into a bottom border count as text over the frame", () => {
    expect(textOverFrames(box(titled, ["harbor"], edge("╰─┐↑ select ↓┌┐⏎ info┌┐quit┌", "╯")))).toHaveLength(1);
  });

  test("an age set into the bottom edge a space inside its edge cells is not text over the frame", () => {
    expect(textOverFrames(box(titled, ["harbor"], edge("╰─ read 3s ago ", "╯")))).toEqual([]);
  });

  test("a row drawn over a box's right side counts as text over the frame", () => {
    const screen = screenOf([titled, "│ " + "harbor-old-fix ".repeat(4), closed], columns);
    expect(textOverFrames(screen)).toHaveLength(1);
  });

  test("a cadence beside the name rather than at the title's right end is caught", () => {
    expect(cadencesOffTheRight(box(edge("╭─ tasks ↻ 2s ", "╮"), ["harbor"], closed))).toHaveLength(1);
  });

  test("the projects notice's last word alone on its line is caught", () => {
    expect(lonelyWords(box(titled, ["ORC_DASH_TASKS is unset, so only tasks sampled earlier", "show"], closed))).toHaveLength(1);
  });

  test("a one-word heading under a short row is not a word wrapped alone", () => {
    expect(lonelyWords(screenOf(["+2 more rows", "alerts", "quota-pace none recorded"], 80))).toEqual([]);
  });

  test("a row wider than the screen runs past the right edge", () => {
    expect(pastTheRightEdge(screenOf(["x".repeat(81)], 80))).toHaveLength(1);
  });

  test("two boxes drawn over each other share cells", () => {
    expect(sharedCells(screenOf(["╭──╮", "│╭──╮", "╰│──╯", " ╰──╯"], 6))).toHaveLength(1);
  });
});

const accountLabels = (columns: number): ReadonlyArray<string> => {
  const blocks = quotaBlocksOf(fixture("quota-axi/full.json"), orcQuotaText("main-second"));
  const rows = quotaLines(blocks, panelWidth(columns), true, dashboardNow).map(plain);
  return ["● account main", "● account second"].map((header) => rows[rows.findIndex((row) => row.startsWith(header)) + 1]?.split(/ (?=[━─╸┃])/u)[0]?.trimEnd() ?? "");
};

describe("the quota panel names an orc quota account's row in full", () => {
  test.each(widths)("each account row reads all models, not all mod…, at %d columns", (columns) => {
    expect(accountLabels(columns)).toEqual(["all models", "all models"]);
  });
});
