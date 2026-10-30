import { describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { Effect, Fiber, Layer } from "effect";
import { CommandRunner, HarvestLogSource, homeLogRoots, nothingCaptured, quotaSourceLayer } from "@tui-dash/schema";
import { livePanel } from "@tui-dash/quota";
import { fixture } from "../../lib/fixtures";
import { recordedSavedProfilesLayer } from "../../lib/saved-profiles";

const noLogs = Layer.succeed(HarvestLogSource, { read: () => Effect.succeed({ home: "/home/tester", roots: homeLogRoots("/home/tester"), files: [], captured: nothingCaptured }) });

const freshFixture = (relative: string): string => {
  const delta = Date.now() - Date.parse("2026-10-13T20:18:16Z");
  const shift = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return value;
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? value : new Date(parsed + delta).toISOString();
    }
    if (Array.isArray(value)) return value.map(shift);
    if (typeof value === "object" && value !== null)
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, shift(entry)]));
    return value;
  };
  return JSON.stringify(shift(JSON.parse(fixture(relative))));
};

const recordedSources = Layer.merge(quotaSourceLayer, recordedSavedProfilesLayer).pipe(
  Layer.provide(
    Layer.succeed(CommandRunner, {
      run: (command) =>
        Effect.succeed(freshFixture(command.argv[0] === "quota-axi" ? "quota-axi/full.json" : "saved-profiles/status.json")),
    }),
  ),
  Layer.merge(noLogs),
);

const rowsOf = (frame: string) =>
  frame
    .split("\n")
    .map((row) => row.trimEnd())
    .filter((row) => row !== "");

const frameWhere = async (setup: TestRendererSetup, matches: (frame: string) => boolean): Promise<string> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await Bun.sleep(10);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (matches(frame)) return frame;
  }
  throw new Error("no frame matched");
};

describe("the live panel", () => {
  test("paints its first reading at once, and lays it out again for a narrower terminal before the next read", async () => {
    const setup = await createTestRenderer({ width: 84, height: 30 });
    const fiber = Effect.runFork(livePanel(setup.renderer).pipe(Effect.provide(recordedSources)));
    try {
      const wide = rowsOf(await frameWhere(setup, (frame) => frame.includes("\u25cf")));
      setup.resize(40, 30);
      const narrow = rowsOf(await frameWhere(setup, (frame) => frame.split("\n")[0]?.length === 40));
      expect(narrow).toHaveLength(wide.length);
      const meteredRows = narrow.filter((row) => /[━╸─]/u.test(row));
      expect(meteredRows.length).toBeGreaterThan(0);
      expect(meteredRows.every((row) => /\d+%/u.test(row))).toBe(true);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await setup.dispose();
    }
  });

  test("ends the program when the quit key is pressed", async () => {
    const setup = await createTestRenderer({ width: 84, height: 30 });
    const fiber = Effect.runFork(livePanel(setup.renderer).pipe(Effect.provide(recordedSources)));
    try {
      await frameWhere(setup, (frame) => frame.includes("\u25cf"));
      setup.renderer.keyInput.processParsedKey({
        name: "q",
        ctrl: false,
        meta: false,
        shift: false,
        option: false,
        sequence: "q",
        number: false,
        raw: "q",
        eventType: "press",
        source: "raw",
      });
      await Effect.runPromise(Fiber.join(fiber).pipe(Effect.timeout("5 seconds")));
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await setup.dispose();
    }
  });

  test("clips rather than wraps its rows in a terminal narrower than its 30 column minimum", async () => {
    const setup = await createTestRenderer({ width: 30, height: 30 });
    const fiber = Effect.runFork(livePanel(setup.renderer).pipe(Effect.provide(recordedSources)));
    try {
      const minimum = rowsOf(await frameWhere(setup, (frame) => frame.includes("\u25cf")));
      setup.resize(25, 30);
      const narrower = rowsOf(await frameWhere(setup, (frame) => frame.split("\n")[0]?.length === 25));
      expect(narrower).toEqual(minimum.map((row) => row.slice(0, 25).trimEnd()));
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await setup.dispose();
    }
  });
});
