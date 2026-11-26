import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { savedReadingsLayer } from "@avi2dg/orc-schema";
import { dashboardSources, frameWhere, recordedAnswer, tasksCommand, withLivePanel } from "../../lib/dashboard-sources";
import { boxText } from "../../lib/host-fixture";

const remoteResourcesCommand = "ssh south.example.com orc-dash-resources --json";

const ledgerLayout = join(import.meta.dir, "..", "..", "fixtures", "config", "ledger.json");

const withClock = <A>(body: (clock: TestClock.TestClock) => Promise<A>): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(TestClock.make(), (clock) => Effect.promise(() => body(clock)))));

const waitFor = async (ready: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 400 && !ready(); attempt += 1) await Bun.sleep(25);
  expect(ready()).toBe(true);
};

describe("the live dashboard's cadences", () => {
  // No tasks command is set, so the tasks listing never lists anything.
  test(
    "reads the machines every 10 seconds and the quota with them, and repaints on the 2 second tick once every box has answered",
    () => withClock(async (clock) => {
      const asked: Array<{ command: string; at: number }> = [];
      let passes = 0;
      const sources = dashboardSources({
        env: { ORC_DASH_MACHINE: "north", ORC_DASH_REMOTE_MACHINE: "south", ORC_DASH_REMOTE_RESOURCES: remoteResourcesCommand },
        run: (command) =>
          Effect.sync(() => {
            asked.push({ command: command.argv.join(" "), at: clock.currentTimeMillisUnsafe() });
            return recordedAnswer(command);
          }),
        samples: {
          read: () =>
            Effect.sync(() => {
              passes += 1;
              return [];
            }),
          append: () => Effect.void,
        },
      });
      await withLivePanel({ width: 84, height: 24 }, sources, async () => {
        await waitFor(() => asked.some((entry) => entry.command.includes(remoteResourcesCommand)));
        await Effect.runPromise(clock.adjust("10 seconds"));
        await waitFor(() => asked.filter((entry) => entry.command.includes(remoteResourcesCommand)).length >= 2);
      }, clock);
      const machineReads = asked.filter((entry) => entry.command.includes(remoteResourcesCommand));
      const quotaReads = asked.filter((entry) => entry.command.startsWith("quota-axi")).length;
      expect(machineReads.length).toBeGreaterThanOrEqual(2);
      expect((machineReads[1]?.at ?? 0) - (machineReads[0]?.at ?? 0)).toBeGreaterThanOrEqual(10_000);
      expect([quotaReads <= 2, passes <= 10]).toEqual([true, true]);
    }),
    30_000,
  );
});

describe("the live dashboard's ledger cadence", () => {
  test(
    "reads the ledger every 10 seconds rather than on each paint",
    () => withClock(async (clock) => {
      const reads: Array<number> = [];
      const conversation = {
        read: () =>
          Effect.sync(() => {
            reads.push(clock.currentTimeMillisUnsafe());
            return { sessions: "set" as const, said: [] };
          }),
      };
      const sources = dashboardSources({ run: (command) => Effect.sync(() => recordedAnswer(command)), config: ledgerLayout, conversation });
      await withLivePanel({ width: 84, height: 24 }, sources, async () => {
        await waitFor(() => reads.length >= 1);
        await Effect.runPromise(clock.adjust("10 seconds"));
        await waitFor(() => reads.length >= 2);
      }, clock);
      expect(reads.length).toBeGreaterThanOrEqual(2);
      expect((reads[1] ?? 0) - (reads[0] ?? 0)).toBeGreaterThanOrEqual(10_000);
    }),
    30_000,
  );
});

describe("the live dashboard's machines cadence", () => {
  // Waiting for the next cadence boundary turns a 10.8-second sample into a 20-second sampling interval.
  test(
    "starts the next read of a machine slower than its cadence as soon as the last one lands",
    () => withClock(async (clock) => {
      const sampleStarts: Array<number> = [];
      const sources = dashboardSources({
        run: (command) => {
          const cpuSample = command.argv[0] === "top" || command.argv.join(" ").startsWith("sh -c head -n 1 /proc/stat");
          if (!cpuSample) return Effect.sync(() => recordedAnswer(command));
          sampleStarts.push(clock.currentTimeMillisUnsafe());
          return Effect.as(Effect.sleep("10800 millis"), recordedAnswer(command));
        },
      });
      await withLivePanel({ width: 84, height: 24 }, sources, async () => {
        await waitFor(() => sampleStarts.length >= 2);
        await Effect.runPromise(clock.adjust("10800 millis"));
        await waitFor(() => sampleStarts.length >= 4);
      }, clock);
      const firstFour = sampleStarts.slice(0, 4);
      expect(firstFour).toHaveLength(4);
      expect(Math.max(...firstFour.slice(1).map((start, index) => start - (firstFour[index] ?? start)))).toBeLessThan(13_500);
    }),
    60_000,
  );
});

const withStateDirectory = async (body: (directory: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), "orc-dash-cache-"));
  try {
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const env = { ORC_DASH_MACHINE: "north", ORC_DASH_TASKS: tasksCommand };

describe("the live dashboard's saved readings", () => {
  test(
    "paint every box from the last start's saved readings, with no age in any tab, while the next start's sources have not answered",
    () =>
      withStateDirectory(async (state) => {
        const saved = savedReadingsLayer.pipe(
          Layer.provide(BunFileSystem.layer),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: "/home/tester", XDG_STATE_HOME: state }))),
        );
        const size = { width: 240, height: 60 };
        await withLivePanel(size, dashboardSources({ env, saved, run: (command) => Effect.sync(() => recordedAnswer(command)) }), (setup) =>
          frameWhere(setup, (frame) => frame.includes("harbor") && frame.includes("\u25cf claude main \u00b7 max") && frame.includes("pueue") && !frame.includes("reading") && !frame.includes("checking")),
        );
        const frame = await withLivePanel(size, dashboardSources({ env, saved, run: () => Effect.never }), (setup) =>
          frameWhere(setup, (text) => text.includes("harbor") && text.includes("\u25cf claude main \u00b7 max") && text.includes("pueue")),
        );
        const titles = frame
          .split("\n")
          .flatMap((row) => [...row.matchAll(/╭─ (.*?) ─*╮/gu)].map((match) => (match.at(1) ?? "").trimEnd()));
        for (const [name, cadence] of [
          ["quota", "10s"],
          ["gluttons | alerts", "2s"],
          ["machines", "10s"],
          ["queue | scheduled", "10s"],
          ["projects \u00b7 today", "10s"],
          ["harbor \u00b7 tasks", "10s"],
        ] as const) {
          expect(titles.some((title) => title.startsWith(name) && title.endsWith(`\u21bb ${cadence}`))).toBe(true);
        }
        expect(titles.some((title) => title.includes("saved"))).toBe(false);
        expect(frame).not.toContain("pueue reading");
        expect([frame.includes("harbor"), frame.includes("\u25cf claude main \u00b7 max"), frame.includes("\u25b6 pueue unknown")]).toEqual([true, true, true]);
        expect([frame.includes("reading the machines"), frame.includes("reading the quota")]).toEqual([false, false]);
      }),
    30_000,
  );
});

const localCpu = process.platform === "darwin" ? "cpu 14%" : "cpu 11%";

const answeringOnce = () => {
  const asked = new Set<string>();
  return dashboardSources({
    env,
    run: (command) =>
      Effect.suspend(() => {
        const key = command.argv.join(" ");
        if (asked.has(key)) return Effect.never;
        asked.add(key);
        return Effect.sync(() => recordedAnswer(command));
      }),
  });
};

describe("the live dashboard's hanging readings", () => {
  test(
    "keep the machines' last reading on show and say its growing age while the next read hangs",
    () =>
      withClock((clock) => withLivePanel({ width: 240, height: 60 }, answeringOnce(), async (setup) => {
        const fresh = boxText(await frameWhere(setup, (frame) => boxText(frame, "machines").includes(localCpu)), "machines");
        expect(fresh).toMatch(/read 0s ago/u);
        await Effect.runPromise(clock.adjust("20 seconds"));
        const late = boxText(await frameWhere(setup, (frame) => /read 2\ds ago \u00b7 reading\u2026/u.test(boxText(frame, "machines"))), "machines");
        expect(late).toContain(localCpu);
      }, clock)),
    40_000,
  );
});
