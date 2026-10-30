import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Fiber, Layer, Schema } from "effect";
import { TestClock, TestConsole } from "effect/testing";
import { type AlertReaders, streamAlerts } from "@tui-dash/cli";
import { AlertEvent, defaultAlertSettings, type ResourcesReport, type TaskEntry } from "@tui-dash/schema";

const start = DateTime.makeUnsafe("2026-10-19T09:00:00Z");

const heavyRemote = (generatedAt: DateTime.Utc): ResourcesReport => ({
  schemaVersion: 1,
  generatedAt: DateTime.formatIso(generatedAt),
  machine: {
    cpu: { kind: "ok", value: { percent: 95, cores: 16 } },
    memory: { kind: "ok", value: { usedBytes: 20, totalBytes: 100 } },
    load: { kind: "ok", value: [20, 20, 20] },
    processes: { kind: "ok", value: [{ pid: 11, program: "bun", cpuPercent: 90, residentBytes: 10 }] },
  },
  gpu: null,
});

const quietTask: TaskEntry = {
  id: "bridge-plot",
  title: "Plot the bridge migration",
  project: "harbor",
  kind: "build",
  state: "working",
  endedAt: null,
  detail: "Moving the bridge queue",
  startedAt: start,
  firstStartedAt: start,
  folders: [],
  branches: [],
};

const readers: AlertReaders<never> = {
  nightly: Effect.succeed({ schedules: [], report: { repos: [], runs: [], failures: [] } }),
  quota: Effect.never,
  resources: Effect.map(DateTime.now, (now) => [{ name: "remote", reading: { kind: "ok", value: heavyRemote(now) } }]),
  tasks: Effect.succeed([
    {
      name: "north",
      reading: {
        kind: "ok",
        value: { generatedAt: start, view: { orchestrator: { name: "harbor", version: "0.9.0" }, tasks: [quietTask], planned: [], overhead: [], schedules: [], registered: [] } },
      },
    },
  ]),
};

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(AlertEvent));

// Each step hands the forked stream real time to run the round the test clock just woke.
const settle = Effect.promise(() => Bun.sleep(1));

// Oracle: the step 2 text, heavy load after 5 straight minutes and once per episode, long task after 15 quiet minutes and every 15 after,
// and the brief's rule that each source has its own timeout and fails without blocking the others.
// Rejects a stream that waits on the quota source before the others, that prints anything but alert lines, or that repeats the heavy load alert.
const streamedFor31Minutes = async (from: AlertReaders<never>): Promise<ReadonlyArray<AlertEvent>> => {
  const lines = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(start));
      const stream = yield* Effect.forkChild(streamAlerts(from, defaultAlertSettings));
      yield* settle;
      for (let step = 0; step < 62; step += 1) {
        yield* TestClock.adjust("30 seconds");
        yield* settle;
      }
      yield* Fiber.interrupt(stream);
      return (yield* TestConsole.logLines).map(String);
    }).pipe(Effect.provide(Layer.merge(TestConsole.layer, TestClock.layer()))),
  );
  return lines.map((line) => decodeEvent(line));
};

const expectedEvents = [
  ["heavy-load", "2026-10-19T09:05:00.000Z", "remote"],
  ["long-task", "2026-10-19T09:15:00.000Z", "quiet"],
  ["long-task", "2026-10-19T09:30:00.000Z", "quiet"],
];

const summaryOf = (event: AlertEvent) => [event.rule, event.at, event.rule === "long-task" ? event.reason : event.rule === "heavy-load" ? event.machine : ""];

describe("tui-dash alerts --json", () => {
  test("prints each rule's events as JSON lines on the default timings while a source never answers", async () => {
    expect((await streamedFor31Minutes(readers)).map(summaryOf)).toEqual(expectedEvents);
  });

  // Oracle: the brief's rule that each source has its own timeout and fails without blocking the others,
  // and the property that a rule polling once a minute must not hold more than one unanswered read.
  // Rejects a stream that starts a fresh quota read every minute behind one that ignores its interruption.
  test("starts no second quota read while one that ignores its interruption is still out, and the other rules carry on", async () => {
    let started = 0;
    const stuckQuota = Effect.uninterruptible(Effect.andThen(Effect.sync(() => (started += 1)), Effect.never));
    const events = await streamedFor31Minutes({ ...readers, quota: stuckQuota });
    expect(started).toBe(1);
    expect(events.map(summaryOf)).toEqual(expectedEvents);
  });
});
