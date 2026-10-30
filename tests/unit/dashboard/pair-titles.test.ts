import { describe, expect, test } from "bun:test";
import { type Line, plain } from "@tui-dash/ui";
import { bandedDrawn, bandedLines, bandedScreen, type Step, stepped } from "../../lib/host-fixture";

const titlesOf = (line: Line): ReadonlyArray<Line> => {
  const titles: Array<Line> = [];
  let current: Line = [];
  for (const part of line) {
    if (part.text.startsWith("\u256d") && current.length > 0) {
      titles.push(current);
      current = [];
    }
    current = [...current, part];
    if (part.text.endsWith("\u256e")) {
      titles.push(current);
      current = [];
    }
  }
  return titles;
};

const titlesOn = (columns: number, steps: ReadonlyArray<Step> = []): ReadonlyArray<Line> => bandedDrawn(columns, 40, steps).block.flatMap(titlesOf);

const size = { columns: 120, rows: 40 };

const after = (steps: ReadonlyArray<Step>) => stepped(bandedScreen(), size, steps);

const frameAfter = (steps: ReadonlyArray<Step>): string => bandedLines(size.columns, size.rows, steps).join("\n");

// The frame and the right-pinned cadence surround the name, so the name is what sits between them.
const nameOf = (half: Line): Line => {
  const named = half.slice(half[0]?.text.startsWith("\u256d") ?? false ? 1 : 0);
  const tail = named.findIndex((part) => part.text.includes("\u21bb") || /^\u2500+$/.test(part.text));
  return named.slice(0, tail === -1 ? undefined : tail);
};

const halvesOf = (pair: Line): readonly [Line, Line] => {
  const bar = pair.findIndex((part) => part.text === " | ");
  return [pair.slice(0, bar), pair.slice(bar + 1)];
};

const checkHalf = (half: Line, name: string, key: string, open: boolean): void => {
  const spans = [...nameOf(half)];
  while (spans.length > 0 && (spans.at(-1)?.text.trim() ?? "") === "") spans.pop();
  expect(spans.map((part) => part.text).join("")).toBe(name);
  const keyed = spans.filter((part) => part.text === key);
  expect(keyed).toHaveLength(1);
  expect(keyed[0]?.style).toMatchObject({ tone: "accent", bold: true });
  for (const part of spans.filter((rest) => rest.text !== key)) {
    expect(part.style.tone).toBe(open ? "focus" : "muted");
    if (open) expect(part.style.bold).toBe(true);
  }
};

const keys: Record<string, string> = { gluttons: "g", alerts: "a", queue: "u", scheduled: "s" };

describe("the banded dashboard\u2019s shared pair titles", () => {
  for (const navigation of [
    { steps: [], notices: "gluttons", queue: "queue" },
    { steps: [{ press: "a" }], notices: "alerts", queue: "queue" },
    { steps: [{ press: "s" }], notices: "gluttons", queue: "scheduled" },
  ] as const) {
    test(`shares one bar-split title per pair with the bright letter glowing bare inside each half on ${navigation.notices}/${navigation.queue}`, () => {
      const titles = titlesOn(120, navigation.steps);
      for (const title of titles) expect(plain(title)).not.toMatch(/[()]/u);
      const notices = titles.find((title) => plain(title).includes("gluttons") && plain(title).includes("alerts"));
      expect(notices).toBeDefined();
      if (notices === undefined) throw new Error("no shared notices title");
      const [gluttons, alerts] = halvesOf(notices);
      checkHalf(gluttons, "gluttons", keys["gluttons"] ?? "", navigation.notices === "gluttons");
      checkHalf(alerts, "alerts", keys["alerts"] ?? "", navigation.notices === "alerts");
      expect(plain(notices)).toMatch(/\u21bb 2s \u2500*\u256e/u);
      const queue = titles.find((title) => plain(title).includes("queue") && plain(title).includes("scheduled"));
      expect(queue).toBeDefined();
      if (queue === undefined) throw new Error("no shared queue title");
      const [queued, scheduled] = halvesOf(queue);
      checkHalf(queued, "queue", keys["queue"] ?? "", navigation.queue === "queue");
      checkHalf(scheduled, "scheduled", keys["scheduled"] ?? "", navigation.queue === "scheduled");
      expect(plain(queue)).toMatch(/\u21bb 10s \u2500*\u256e/u);
    });
  }

  test("lights only the ledger\u2019s and the projects\u2019 keys in the single titles", () => {
    const singles = titlesOn(120).filter((title) => !plain(title).includes(" | "));
    const keyed = singles.filter((title) => title.some((part) => part.style.tone === "accent"));
    const keyOf = (title: Line): string | undefined => title.find((part) => part.style.tone === "accent")?.text;
    expect(keyed).toHaveLength(2);
    expect(keyed.map(keyOf).toSorted((left, right) => (left ?? "").localeCompare(right ?? ""))).toEqual(["l", "p"]);
    const ledger = singles.find((title) => plain(title).includes("ledger"));
    expect(ledger).toBeDefined();
    if (ledger === undefined) throw new Error("no ledger title");
    expect(nameOf(ledger).map((part) => part.text).join("")).toMatch(/^ledger/iu);
    const quota = singles.find((title) => plain(title).includes("quota"));
    expect(quota?.some((part) => part.style.tone === "accent")).toBe(false);
  });

  test("keeps the day and the cadence on the ledger title", () => {
    const list = bandedLines(120, 40, [{ press: "l" }]).find((line) => line.includes("ledger \u00b7"));
    expect(list).toContain("ledger \u00b7 today");
    expect(list).toContain("\u21bb 10s");
    expect(list).not.toContain("\u2026");
  });

  // q is reserved for quitting, so the queue uses u.
  test("switches the shared box between the queue and the scheduled list on u and s", () => {
    const scheduled = frameAfter([{ press: "s" }]);
    expect(scheduled).toContain("backup");
    expect(scheduled).not.toContain("4 running \u00b7 1 waiting \u00b7 2 queued in pueue");
    expect(frameAfter([{ press: "s" }, { press: "u" }])).toBe(frameAfter([]));
    expect(after([{ press: "s" }]).open.get("queues|schedules")).toBe("schedules");
    expect(after([{ press: "s" }, { press: "u" }]).open.get("queues|schedules")).toBe("queues");
    expect(frameAfter([{ press: "n" }])).toBe(frameAfter([]));
    expect(frameAfter([{ press: "q" }])).toBe(frameAfter([]));
  });

  test("switches halves on their highlighted letters and names no key for the machines box", () => {
    expect(frameAfter([{ press: "m" }])).toBe(frameAfter([]));
    expect(after([{ press: "m" }]).focus).toBeUndefined();
    expect(after([{ press: "s" }]).open.get("queues|schedules")).toBe("schedules");
    expect(after([{ press: "a" }]).open.get("session-quota|alerts")).toBe("alerts");
    expect(after([{ press: "a" }, { press: "g" }]).open.get("session-quota|alerts")).toBe("session-quota");
    expect(after([{ press: "p" }]).focus).toBe("tasks");
    expect(after([{ press: "l" }]).focus).toBe("ledger");
    expect(frameAfter([{ press: "x" }])).toBe(frameAfter([]));
  });
});
