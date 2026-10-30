import { describe, expect, test } from "bun:test";
import { Clock, DateTime, type Duration, Effect, Fiber, Layer, Option, Schema } from "effect";
import { TestClock, TestConsole } from "effect/testing";
import { modules } from "@tui-dash/cli";
import { dashboardScreen } from "@tui-dash/dashboard";
import {
  type Command,
  decodePueue,
  ok,
  type QueueReadings,
  QueuesCodec,
  readConfig,
  ReadModeReference,
  RunnerRepos,
  SavedReadings,
  type SavedSlot,
} from "@tui-dash/schema";
import { plain } from "@tui-dash/ui";
import { dashboardNow } from "../../lib/dashboard-fixture";
import { dashboardSources, printedDashboard, recordedAnswer, tasksCommand } from "../../lib/dashboard-sources";
import { fixture } from "../../lib/fixtures";
import { boxText } from "../../lib/host-fixture";
import { fixtureActionsRepo } from "../../lib/queues-fixture";

const startMillis = DateTime.toEpochMillis(dashboardNow);

const bottomEdge = (box: string): string => box.split("\n").at(-1) ?? "";

// One listed repository makes the CI boundary issue its `gh api` reads, which the stalling run then holds.
const stubRepos = Layer.succeed(
  RunnerRepos,
  Option.some({ read: Effect.succeed({ ...ok(["example/toolshed"]), capturedAt: dashboardNow }) }),
);

// The CI boundary answers its first round at once, then holds the next one past the draw, so a refresh is in flight at the draw.
const ciOnceRun = (command: Command) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    command.argv[0] === "gh" && command.argv[1] === "api" && now - startMillis > 1_000 ? Effect.never : Effect.succeed(recordedAnswer(command)),
  );

const liveFrame = (afterMount: Duration.Input, beforeDraw: Duration.Input) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startMillis);
    const { config } = yield* readConfig;
    const screen = yield* dashboardScreen(modules, config);
    yield* TestClock.adjust(afterMount);
    yield* screen.read;
    // A zero-patience poll answers with its last landing while the new fiber runs, so a second read picks up what landed.
    yield* TestClock.adjust("2 seconds");
    yield* screen.read;
    yield* TestClock.adjust(beforeDraw);
    const now = yield* Clock.currentTimeMillis;
    const draw = (columns: number, rows: number): string => screen.draw(now, screen.initial, columns, rows).block.map(plain).join("\n");
    return { wide: draw(240, 60), glance: draw(84, 40) };
  }).pipe(
    Effect.scoped,
    Effect.provide(dashboardSources({ env: { TUI_DASH_TASKS: tasksCommand }, run: ciOnceRun, repos: stubRepos })),
    Effect.provideService(ReadModeReference, "live"),
    Effect.provide(TestClock.layer()),
  );

// The first CI round starts at once and lands 5 s later with its capture at t=0, so the box keeps showing that capture age.
const ciDelayedRun = () => {
  let delayed = false;
  return (command: Command): Effect.Effect<string> =>
    command.argv[0] === "gh" && command.argv[1] === "api" && !delayed
      ? Effect.delay(
          Effect.sync(() => {
            delayed = true;
            return recordedAnswer(command);
          }),
          "5 seconds",
        )
      : Effect.succeed(recordedAnswer(command));
};

const cachedCiFrame = () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(startMillis);
      const { config } = yield* readConfig;
      const screen = yield* dashboardScreen(modules, config);
      yield* screen.read;
      for (let elapsed = 0; elapsed < 76; elapsed += 2) {
        yield* TestClock.adjust("2 seconds");
        yield* screen.read;
      }
      yield* TestClock.adjust("1 second");
      yield* screen.read;
      // The ticks wake each round on the test clock, and this hands the forked reads real time to land it.
      yield* Effect.promise(() => Bun.sleep(50));
      yield* screen.read;
      const now = yield* Clock.currentTimeMillis;
      const draw = (columns: number, rows: number): string => screen.draw(now, screen.initial, columns, rows).block.map(plain).join("\n");
      return { wide: draw(240, 60), glance: draw(84, 40) };
    }),
  ).pipe(
    Effect.provide(dashboardSources({ env: { TUI_DASH_TASKS: tasksCommand }, run: ciDelayedRun(), repos: stubRepos })),
    Effect.provideService(ReadModeReference, "live"),
    Effect.provide(TestClock.layer()),
  );

// A source that never answers hangs the polls behind it, so the queue keeps its saved copy on show.
const hangingRun = (command: Command): Effect.Effect<string> =>
  command.argv[0] === "pueue" || command.argv[0] === "gh" ? Effect.never : Effect.succeed(recordedAnswer(command));

// The pueue answer lands last, so the print finishes 71 s after the readings beside it.
const slowPueueRun = (command: Command): Effect.Effect<string> =>
  command.argv[0] === "pueue" ? Effect.delay(Effect.sync(() => recordedAnswer(command)), "71 seconds") : Effect.succeed(recordedAnswer(command));

const printedAged = (width: number, height: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(startMillis);
      const fiber = yield* Effect.forkScoped(
        printedDashboard({ width, height, color: false }, dashboardSources({ env: { TUI_DASH_TASKS: tasksCommand }, run: slowPueueRun })),
      );
      yield* Effect.forkScoped(Effect.forever(TestClock.adjust("1 second")));
      yield* Fiber.join(fiber);
      return (yield* TestConsole.logLines).map(String).join("\n");
    }),
  ).pipe(Effect.provide(Layer.mergeAll(TestConsole.layer, TestClock.layer())));

describe("a cached CI report reused past its capture", () => {
  test("shows the capture age with no reading claim on the box bottom edge at 77 s", async () => {
    const { wide } = await Effect.runPromise(cachedCiFrame());
    const edge = bottomEdge(boxText(wide, "queue | scheduled"));
    expect(edge).toStartWith("\u2570\u2500 read 1m ago ");
    expect(edge).not.toContain("reading\u2026");
  }, 30_000);

  test("names no reading for the queue in the glance at 77 s", async () => {
    const { glance } = await Effect.runPromise(cachedCiFrame());
    expect(glance.split("\n").filter((line) => line.startsWith("reading") && line.includes("queue"))).toHaveLength(0);
    expect(glance).not.toContain("late readings");
  }, 30_000);
});

describe("a CI refresh hanging past the draw", () => {
  test("pairs the capture age with a reading claim on the box bottom edge at 69 s", async () => {
    const { wide } = await Effect.runPromise(liveFrame("60 seconds", "7 seconds"));
    expect(bottomEdge(boxText(wide, "queue | scheduled"))).toStartWith("\u2570\u2500 read 1m ago \u00b7 reading\u2026 ");
  }, 30_000);

  test("names the refreshing queue in the glance at 69 s", async () => {
    const { glance } = await Effect.runPromise(liveFrame("60 seconds", "7 seconds"));
    expect(glance.split("\n").some((line) => line.startsWith("reading") && line.includes("queue"))).toBe(true);
  }, 30_000);
});

describe("a saved queue standing in while its sources hang", () => {
  test("shows the saved age on the box and in the glance", async () => {
    const at = Date.now() - 3 * 3_600_000;
    const report: QueueReadings = {
      machines: [{ name: "north", status: Option.some(decodePueue(fixture("pueue/status.json"))) }],
      actions: { repo: fixtureActionsRepo, runs: Option.some(ok([])) },
    };
    const stored: unknown = Schema.encodeSync(QueuesCodec)(report);
    const saved = Layer.succeed(SavedReadings, {
      slot: <A>(key: string, codec: Schema.Codec<A, unknown>): SavedSlot<A> => ({
        last: key === "queues" ? Effect.succeed(Option.map(Schema.decodeUnknownOption(codec)(stored), (value) => ({ value, at }))) : Effect.succeedNone,
        keep: () => Effect.void,
      }),
    });
    const sources = dashboardSources({ env: { TUI_DASH_TASKS: tasksCommand }, run: hangingRun, saved });
    const screen = await Effect.runPromise(
      Effect.scoped(Effect.flatMap(readConfig, ({ config }) => dashboardScreen(modules, config))).pipe(
        Effect.provide(sources),
        Effect.provideService(ReadModeReference, "live"),
      ),
    );
    const now = Date.now();
    const wide = screen.draw(now, screen.initial, 240, 60).block.map(plain).join("\n");
    expect(bottomEdge(boxText(wide, "queue | scheduled"))).toStartWith("\u2570\u2500 read 3h ago \u00b7 reading\u2026 ");
    const glance = screen.draw(now, screen.initial, 84, 40).block.map(plain).join("\n");
    expect(glance.split("\n").some((line) => line.startsWith("saved readings") && line.includes("queue 3h ago"))).toBe(true);
    expect(glance.split("\n").filter((line) => line.startsWith("late readings"))).toHaveLength(0);
  }, 30_000);
});

describe("a printed frame held past an early reading's cadence", () => {
  test("claims no refresh age in the boxes", async () => {
    const frame = await Effect.runPromise(printedAged(240, 60));
    expect(frame).not.toContain("reading\u2026");
    expect(frame).not.toContain("late readings");
    expect(frame).toContain("queue");
    expect(bottomEdge(boxText(frame, "queue | scheduled"))).toMatch(/^\u2570\u2500+\u256F$/u);
  }, 30_000);

  test("claims no refresh age in the glance", async () => {
    const frame = await Effect.runPromise(printedAged(84, 40));
    expect(frame).not.toContain("reading\u2026");
    expect(frame).not.toContain("late readings");
    expect(frame).toContain("quota");
  }, 30_000);
});
