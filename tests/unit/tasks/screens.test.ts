import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import { decodeNoMistakes, decodeTasksReport, ok, type TaskLevelReadings, taskLevels } from "@tui-dash/schema";
import { drawTasks, type Navigation, type TasksReadings } from "@tui-dash/tasks";
import { plain } from "@tui-dash/ui";
import { fixture } from "../../lib/fixtures";
import { valueOf } from "../../lib/outcomes";
import { pipelineTaskReadings } from "../../lib/task-levels-fixture";

const readings = (overrides: Partial<TaskLevelReadings> = {}): TasksReadings => ({
  levels: taskLevels(pipelineTaskReadings(overrides)),
  zone: DateTime.zoneMakeNamedUnsafe("UTC"),
});

const frame = (navigation: Navigation, columns: number, rows: number, value = readings()): string =>
  `${drawTasks(value, navigation, columns, rows)
    .block.map((line) => plain(line).trimEnd())
    .join("\n")}\n`;

const ticket = (task: string): Navigation => ({ focus: "task", project: "harbor", task, detail: 0 });

const withStep = (step: string, status: string, run: string) =>
  ok(valueOf(decodeNoMistakes(fixture("no-mistakes/run.txt"))).map((recorded) => ({
    ...recorded,
    status: run,
    steps: recorded.steps.map((entry) => (entry.step === step ? { ...entry, status } : entry)),
  })));

describe("the tasks screen against its pinned frames", () => {
  test("the tasks list at 120 by 40", () => {
    expect(frame({ focus: "tasks", project: "harbor", task: undefined, detail: 0 }, 120, 40)).toBe(
      fixture("screens/tasks-pipe-120x40.txt"),
    );
  });

  test("the task pane at 240 by 60", () => {
    expect(frame({ focus: "task", project: "harbor", task: "north tasks-pipe-full", detail: 0 }, 240, 60)).toBe(
      fixture("screens/tasks-pipe-240x60.txt"),
    );
  });
});

const parkedAs = (id: string) => {
  const reported = valueOf(decodeTasksReport(fixture("tasks/pipeline.json")));
  return ok({ ...reported, view: { ...reported.view, tasks: reported.view.tasks.map((task) => (task.id === id && task.state !== "done" ? { ...task, state: "parked" as const } : task)) } });
};

describe("each ticket state against its pinned frame", () => {
  test("waiting", () => {
    expect(frame(ticket("north tasks-pipe-scout"), 120, 40)).toBe(fixture("screens/tasks-ticket-waiting-120x40.txt"));
  });

  test("parked", () => {
    const parked = readings({ tasks: parkedAs("tasks-pipe-quick") });
    expect(frame(ticket("north tasks-pipe-quick"), 120, 40, parked)).toBe(fixture("screens/tasks-ticket-parked-120x40.txt"));
  });

  test("blocked", () => {
    const blocked = readings({ noMistakes: withStep("ci", "failed", "failed") });
    expect(frame(ticket("north tasks-pipe-full"), 120, 40, blocked)).toBe(fixture("screens/tasks-ticket-blocked-120x40.txt"));
  });

  test("done", () => {
    expect(frame(ticket("north tasks-pipe-local"), 120, 40)).toBe(fixture("screens/tasks-ticket-done-120x40.txt"));
  });
});

const gateParkedAs = (reviewStatus: string, seconds: number) => {
  const reported = valueOf(decodeTasksReport(fixture("tasks/pipeline.json")));
  const tasks = ok({
    ...reported,
    view: {
      ...reported.view,
      tasks: reported.view.tasks.map((task) =>
        task.id === "tasks-pipe-full" && task.state !== "done" ? { ...task, state: "working" as const, detail: "drive call running in background" } : task,
      ),
    },
  });
  const recorded = valueOf(decodeNoMistakes(fixture("no-mistakes/run.txt")));
  const gated = ok(
    recorded.map((run) =>
      run.id === "01M5CFR1F0AA7A1FF8AM4DYM9V"
        ? {
          ...run,
          status: "running",
          parkedSeconds: seconds,
          steps: run.steps.map((step) => (step.step === "review" ? { ...step, status: reviewStatus, active: { seconds: 498, round: "fix 1" } } : step)),
        }
        : run,
    ),
  );
  return readings({ tasks, noMistakes: gated });
};

describe("each review gate against its pinned frame", () => {
  test("a review gate awaiting you", () => {
    expect(frame(ticket("north tasks-pipe-full"), 120, 40, gateParkedAs("awaiting_approval", 7500))).toBe(
      fixture("screens/tasks-ticket-gate-awaiting-120x40.txt"),
    );
  });

  test("a parked review gate", () => {
    expect(frame(ticket("north tasks-pipe-full"), 120, 40, gateParkedAs("parked", 8100))).toBe(
      fixture("screens/tasks-ticket-gate-parked-120x40.txt"),
    );
  });
});
