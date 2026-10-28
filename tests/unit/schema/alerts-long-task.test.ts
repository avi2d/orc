import { describe, expect, test } from "bun:test";
import { DateTime, Schema } from "effect";
import {
  AlertEvent,
  defaultAlertSettings,
  longTaskStart,
  longTaskStep,
  type LongTaskSettings,
  type MachineTasks,
  type Outcome,
  type TaskEntry,
  type TaskState,
} from "@tui-dash/schema";

const start = Date.parse("2026-10-19T09:00:00Z");

const minute = 60_000;

const task = (detail: string, state: Exclude<TaskState, "done"> = "working", firstStartedAt = start): TaskEntry => ({
  id: "bridge-plot",
  title: "Plot the bridge migration",
  project: "harbor",
  kind: "build",
  state,
  endedAt: null,
  detail,
  startedAt: DateTime.makeUnsafe(firstStartedAt),
  firstStartedAt: DateTime.makeUnsafe(firstStartedAt),
  folders: ["/home/example/work/harbor"],
  branches: [],
});

type Sample = { readonly minute: number; readonly tasks: ReadonlyArray<TaskEntry> | "unread" };

const sampleOf = (tasks: Sample["tasks"]): Outcome<ReadonlyArray<MachineTasks>> => ({
  kind: "ok",
  value: [
    {
      name: "north",
      reading:
        tasks === "unread"
          ? { kind: "unreachable", reason: "sh exited 255" }
          : {
              kind: "ok",
              value: { generatedAt: DateTime.makeUnsafe(start), view: { orchestrator: { name: "harbor", version: "0.9.0" }, tasks, planned: [], overhead: [], schedules: [], registered: [] } },
            },
    },
  ],
});

const run = (samples: ReadonlyArray<Sample>, settings: LongTaskSettings = defaultAlertSettings.longTask) => {
  let state = longTaskStart;
  return samples.flatMap((sample) => {
    const stepped = longTaskStep(state, sampleOf(sample.tasks), DateTime.makeUnsafe(start + sample.minute * minute), settings);
    state = stepped.state;
    return stepped.events.map((event) => ({ minute: sample.minute, event }));
  });
};

// Every half minute from minute 0 up to the last minute, the tasks the function returns for that minute.
const every30Seconds = (lastMinute: number, tasksAt: (minute: number) => Sample["tasks"]): ReadonlyArray<Sample> =>
  Array.from({ length: lastMinute * 2 + 1 }, (_, index) => ({ minute: index / 2, tasks: tasksAt(index / 2) }));

const firings = (fired: ReturnType<typeof run>) => fired.map((firing) => [firing.minute, firing.event.reason]);

describe("the long task defaults", () => {
  test("hold the 15 minutes, the 15 minute repeat and the 2 hours the brief names", () => {
    expect(defaultAlertSettings.longTask).toMatchObject({ quietMinutes: 15, repeatMinutes: 15, totalHours: 2 });
  });
});

describe("the long task rule", () => {
  test("fires at 15 quiet minutes and again every 15 minutes while the task stays without a milestone", () => {
    const fired = run(every30Seconds(50, () => [task("Moving the bridge queue")]));
    expect(firings(fired)).toEqual([
      [15, "quiet"],
      [30, "quiet"],
      [45, "quiet"],
    ]);
    expect(fired.map(({ event }) => event.quietMinutes)).toEqual([15, 30, 45]);
  });

  test("counts the 15 minutes from the task's last milestone", () => {
    const fired = run(every30Seconds(39, (at) => [task(at < 10 ? "Moving the bridge queue" : "Testing the new runner")]));
    expect(firings(fired)).toEqual([[25, "quiet"]]);
  });

  test("restarts the repeat when a milestone lands after the first event", () => {
    const fired = run(every30Seconds(50, (at) => [task(at < 20 ? "Moving the bridge queue" : "Testing the new runner")]));
    expect(firings(fired)).toEqual([
      [15, "quiet"],
      [35, "quiet"],
      [50, "quiet"],
    ]);
  });

  test("takes a change of state as a milestone too", () => {
    const fired = run(every30Seconds(25, (at) => [task("Moving the bridge queue", at < 10 ? "working" : "waiting")]));
    expect(firings(fired)).toEqual([[25, "quiet"]]);
  });

  test("fires one quiet event, not one for each missed repeat, after a long gap between samples", () => {
    const quiet = [task("Moving the bridge queue")];
    expect(firings(run([{ minute: 0, tasks: quiet }, { minute: 47, tasks: quiet }, { minute: 59, tasks: quiet }, { minute: 60, tasks: quiet }]))).toEqual([
      [47, "quiet"],
      [60, "quiet"],
    ]);
  });

  test("keeps the quiet clock across a sample the machine could not answer", () => {
    const fired = run(every30Seconds(16, (at) => (at >= 5 && at < 15 ? "unread" : [task("Moving the bridge queue")])));
    expect(firings(fired)).toEqual([[15, "quiet"]]);
  });

  test("fires once when the task passes 2 hours in total, however long it runs after", () => {
    const firstStartedAt = start - 110 * minute;
    const fired = run(every30Seconds(130, (at) => [task(`Step ${Math.floor(at / 5)}`, "working", firstStartedAt)]));
    expect(firings(fired)).toEqual([[10, "total"]]);
    expect(fired[0].event.totalMinutes).toBe(120);
  });

  test("raises no second total event after the task rests parked and comes back", () => {
    const firstStartedAt = start - 130 * minute;
    const fired = run(
      every30Seconds(30, (at) => [task(`Step ${Math.floor(at / 5)}`, at >= 10 && at < 20 ? "parked" : "working", firstStartedAt)]),
    );
    expect(firings(fired)).toEqual([[0, "total"]]);
  });

  test("watches no task that is done or parked", () => {
    const done: TaskEntry = { ...task("Notes for the release", "working", start - 300 * minute), state: "done", endedAt: DateTime.makeUnsafe(start) };
    expect(run(every30Seconds(40, () => [done, { ...task("Held for tomorrow", "parked", start - 300 * minute), id: "held" }]))).toEqual([]);
  });

  test("carries the task and both clocks in an event the alert schema reads back", () => {
    const fired = run(every30Seconds(15, () => [task("Moving the bridge queue", "blocked", start - 30 * minute)]));
    expect(fired).toHaveLength(1);
    const event = fired[0].event;
    expect(Schema.decodeUnknownSync(AlertEvent)(JSON.parse(JSON.stringify(event)))).toEqual(event);
    expect(event).toEqual({
      schemaVersion: 1,
      rule: "long-task",
      reason: "quiet",
      at: "2026-10-19T09:15:00.000Z",
      machine: "north",
      task: {
        id: "bridge-plot",
        title: "Plot the bridge migration",
        project: "harbor",
        state: "blocked",
        detail: "Moving the bridge queue",
        firstStartedAt: "2026-10-19T08:30:00.000Z",
      },
      quietSince: "2026-10-19T09:00:00.000Z",
      quietMinutes: 15,
      totalMinutes: 45,
    });
  });
});
