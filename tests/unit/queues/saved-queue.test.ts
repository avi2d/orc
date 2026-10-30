import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { ConfigProvider, DateTime, Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import {
  ActionsSource,
  decodePueue,
  ok,
  type Outcome,
  PueueMachines,
  type PueueStatus,
  QueueFeed,
  type QueueReadings,
  type Reading,
  ReadModeReference,
  savedReadingsLayer,
} from "@tui-dash/schema";
import { queueFeedLayer } from "@tui-dash/queues";
import { fixture } from "../../lib/fixtures";
import { fixtureActionsRepo } from "../../lib/queues-fixture";

const t0 = DateTime.makeUnsafe("2026-10-25T00:00:00Z");

const decoded = decodePueue(fixture("pueue/status.json"));
if (decoded.kind !== "ok") throw new Error("the recorded pueue status does not decode");
const jobsA: PueueStatus = decoded.value;
const jobsB: PueueStatus = {
  ...jobsA,
  tasks: {
    ...jobsA.tasks,
    "99": { id: 99, command: "sleep 100", path: "/tmp", status: { Running: { start: t0 } } },
  },
};

const withStateDirectory = async (body: (directory: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), "tui-dash-queue-"));
  try {
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const feedAt = (directory: string, pueue: Effect.Effect<Reading<PueueStatus>>) =>
  Layer.provide(
    queueFeedLayer,
    Layer.mergeAll(
      Layer.succeed(PueueMachines, [
        { name: "north", read: pueue, projects: { resolve: () => Effect.void, known: Effect.succeed(new Map()) } },
      ]),
      Layer.succeed(ActionsSource, { repo: fixtureActionsRepo, read: Effect.succeed({ ...ok([]), capturedAt: t0 }) }),
      savedReadingsLayer.pipe(
        Layer.provide(BunFileSystem.layer),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: "/home/tester", XDG_STATE_HOME: directory }))),
      ),
    ),
  );

const taskIds = (status: Option.Option<Outcome<PueueStatus>>): ReadonlyArray<string> =>
  Option.isSome(status) && status.value.kind === "ok" ? Object.keys(status.value.value.tasks) : [];

const jobsOf = (reading: QueueReadings): ReadonlyArray<string> => reading.machines.flatMap((machine) => taskIds(machine.status));

describe("a queue snapshot newer than its source timestamp", () => {
  test(
    "writes through the shared throttle and restores the newer jobs with their source time",
    () =>
      withStateDirectory(async (directory) => {
        let pueue: PueueStatus = jobsA;
        const live = feedAt(directory, Effect.map(DateTime.now, (capturedAt) => ({ ...ok(pueue), capturedAt })));
        await Effect.runPromise(
          Effect.gen(function* () {
            const queue = yield* QueueFeed;
            yield* TestClock.setTime(DateTime.toEpochMillis(t0));
            yield* queue.read;
            yield* TestClock.adjust("2 seconds");
            expect(jobsOf((yield* queue.read).fresh)).not.toContain("99");
            pueue = jobsB;
            yield* TestClock.adjust("11 seconds");
            yield* queue.read;
            yield* TestClock.adjust("12 seconds");
            expect(jobsOf((yield* queue.read).fresh)).toContain("99");
          }).pipe(Effect.scoped, Effect.provide(live), Effect.provideService(ReadModeReference, "live"), Effect.provide(TestClock.layer())),
        );
        const restored = feedAt(directory, Effect.never);
        await Effect.runPromise(
          Effect.gen(function* () {
            const { shown } = yield* (yield* QueueFeed).read;
            expect(shown.kind).toBe("saved");
            if (shown.kind !== "saved") return;
            expect(jobsOf(shown.value)).toContain("99");
            expect(shown.at).toBe(DateTime.toEpochMillis(t0));
          }).pipe(Effect.scoped, Effect.provide(restored), Effect.provideService(ReadModeReference, "live"), Effect.provide(TestClock.layer())),
        );
      }),
    30_000,
  );
});
