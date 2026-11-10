import { describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { ConfigProvider, DateTime, Effect, Fiber, Layer } from "effect";
import { actionsSourceLayer, type HeavyMachine, HeavyMachines, CommandRunner, pueueMachinesLayer } from "@avi2dg/orc-schema";
import { backgroundQueues, livePanel, readQueues } from "@avi2dg/orc-queues";
import { fixtureActionsRepo, queueAnswers } from "../../lib/queues-fixture";

const remoteLine = "ssh south.example.com pueue status --json";

const recordedAnswer = (asked: string): string => queueAnswers.find(([answers]) => asked.startsWith(answers))?.[1] ?? "";

const sourcesWithRemote = (remote: Effect.Effect<string>, heavies: ReadonlyArray<HeavyMachine> = []) => Layer.mergeAll(pueueMachinesLayer, actionsSourceLayer, Layer.succeed(HeavyMachines, heavies)).pipe(
  Layer.provide(
    Layer.succeed(CommandRunner, {
      run: (command) => (command.argv[2] === remoteLine ? remote : Effect.succeed(recordedAnswer(command.argv.join(" ")))),
    }),
  ),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromEnvRecord({ ORC_DASH_MACHINE: "north", ORC_DASH_REMOTE_MACHINE: "south", ORC_DASH_REMOTE_PUEUE: remoteLine, ORC_DASH_ACTIONS_REPO: fixtureActionsRepo }),
    ),
  ),
);

const recordedSources = sourcesWithRemote(Effect.sync(() => recordedAnswer("pueue status --json")));

const divide = String.fromCharCode(10);

const rowsOf = (frame: string): ReadonlyArray<string> =>
  frame
    .split(divide)
    .map((row) => row.trimEnd())
    .filter((row) => row !== "");

const inside = (row: string | undefined): string => (row ?? "").slice(2, -1).trimEnd();

const frameWhere = async (setup: TestRendererSetup, matches: (frame: string) => boolean): Promise<string> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await Bun.sleep(25);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (matches(frame)) return frame;
  }
  throw new Error("no frame matched");
};

describe("the live panel", () => {
  test("paints both machines and the actions from the recorded answers, and lays them out again for a narrower terminal", async () => {
    const setup = await createTestRenderer({ width: 84, height: 30 });
    const fiber = Effect.runFork(livePanel(setup.renderer).pipe(Effect.provide(recordedSources)));
    try {
      const wide = rowsOf(await frameWhere(setup, (frame) => frame.includes("actions · toolshed")));
      expect(wide.length).toBeLessThanOrEqual(30);
      for (const title of ["╭─ pueue north ", "╭─ pueue south ", "╭─ actions · toolshed "]) {
        expect(wide.some((row) => row.startsWith(title))).toBe(true);
      }
      expect(wide).toContain("│ 2 running · 1 waiting" + " ".repeat(60) + "│");
      setup.resize(40, 30);
      const narrow = rowsOf(await frameWhere(setup, (frame) => frame.split(divide)[0]?.length === 40));
      expect(narrow.every((row) => row.length === 40)).toBe(true);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await setup.dispose();
    }
  });

  test("paints this machine and the actions while the other machine has not answered, then paints it once it does", async () => {
    const { promise: remoteHeld, resolve: answerRemote } = Promise.withResolvers<void>();
    const setup = await createTestRenderer({ width: 84, height: 40 });
    const remote = Effect.promise(() => remoteHeld).pipe(Effect.as(recordedAnswer("pueue status --json")));
    const fiber = Effect.runFork(livePanel(setup.renderer).pipe(Effect.provide(sourcesWithRemote(remote))));
    try {
      const first = rowsOf(await frameWhere(setup, (frame) => frame.includes("actions · toolshed")));
      const southOf = (rows: ReadonlyArray<string>) => inside(rows[rows.findIndex((row) => row.startsWith("╭─ pueue south ")) + 1]);
      expect(southOf(first)).toBe("reading…");
      expect(inside(first[1])).toBe("2 running · 2 queued · 1 paused");
      answerRemote();
      const read = rowsOf(await frameWhere(setup, (frame) => !frame.includes("reading…")));
      expect(southOf(read)).toBe("2 running · 2 queued · 1 paused");
    } finally {
      answerRemote();
      await Effect.runPromise(Fiber.interrupt(fiber));
      await setup.dispose();
    }
  }, 15_000);
});

describe("the standalone queues panel", () => {
  const countingHeavy = (reads: { count: number }): HeavyMachine => ({
    name: "north",
    read: Effect.map(DateTime.now, (capturedAt) => {
      reads.count += 1;
      return { kind: "ok" as const, value: { group: "heavy", parallel: 1, running: [], queued: [], bypass: 0, bypassWeek: 0 }, capturedAt };
    }),
  });

  test("reading the queues never reads a machine's heavy check", async () => {
    const reads = { count: 0 };
    await Effect.runPromise(readQueues.pipe(Effect.provide(sourcesWithRemote(Effect.succeed(recordedAnswer("pueue status --json")), [countingHeavy(reads)]))));
    expect(reads.count).toBe(0);
  });

  test("the background queues never read a machine's heavy check", async () => {
    const reads = { count: 0 };
    const sources = sourcesWithRemote(Effect.succeed(recordedAnswer("pueue status --json")), [countingHeavy(reads)]);
    await Effect.runPromise(Effect.scoped(Effect.flatMap(backgroundQueues, (read) => read)).pipe(Effect.provide(sources)));
    expect(reads.count).toBe(0);
  });
});
