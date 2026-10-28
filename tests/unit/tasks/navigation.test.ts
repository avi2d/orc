import { describe, expect, test } from "bun:test";
import { decodeTasksReport, taskLevels } from "@tui-dash/schema";
import { moved, type Navigation, startNavigation } from "@tui-dash/tasks";
import { fixture } from "../../lib/fixtures";
import { taskReadings } from "../../lib/task-levels-fixture";

const levels = taskLevels(
  taskReadings({ tasks: decodeTasksReport(fixture("tasks/east.json").replace("2026-10-18T15:30:00.000Z", "2026-10-19T07:30:00.000Z")) }),
);

const after = (moves: ReadonlyArray<Parameters<typeof moved>[2]>, from: Navigation = startNavigation): Navigation =>
  moves.reduce((navigation, move) => moved(levels, navigation, move), from);

describe("moving through the levels", () => {
  test("starts on the projects with the first one picked", () => {
    expect(after([])).toEqual({ focus: "projects", project: undefined, task: undefined, detail: 0 });
  });

  test("down picks the next project and stops at the last", () => {
    expect(after(["down"]).project).toBe("notes");
    expect(after(["down", "down", "down"]).project).toBe("notes");
    expect(after(["down", "up", "up"]).project).toBe("harbor");
  });

  test("steps into the picked project, then into its picked task, and no further", () => {
    expect(after(["in"])).toEqual({ focus: "tasks", project: "harbor", task: undefined, detail: 0 });
    expect(after(["in", "down", "down", "in"])).toEqual({ focus: "task", project: "harbor", task: "north harbor-gone", detail: 0 });
    expect(after(["in", "in", "in"])).toEqual({ focus: "task", project: "harbor", task: "north tasks-bridge-plot", detail: 0 });
  });

  test("steps back one level at a time and keeps the picks it held", () => {
    const deep = after(["in", "down", "in"]);
    expect(after(["out"], deep)).toEqual({ focus: "tasks", project: "harbor", task: "north tasks-inbox-sweep", detail: 0 });
    expect(after(["out", "out", "out"], deep)).toEqual({ focus: "projects", project: "harbor", task: "north tasks-inbox-sweep", detail: 0 });
  });

  test("a step in lands on the first row rather than the pick held from before", () => {
    expect(after(["in", "down", "in", "out", "out", "in"])).toEqual({ focus: "tasks", project: "harbor", task: undefined, detail: 0 });
  });

  test("a new project drops the task picked in the old one", () => {
    expect(after(["in", "down", "out", "down"])).toEqual({ focus: "projects", project: "notes", task: undefined, detail: 0 });
  });

  test("on one task, up and down pick its processes and test runs and stop at either end", () => {
    const deep = after(["in", "in"]);
    expect(after(["up"], deep)).toBe(deep);
    expect(after(["down", "down"], deep).detail).toBe(2);
    expect(after(Array.from({ length: 9 }, () => "down" as const), deep).detail).toBe(6);
  });

  test("a task picked anew starts at its first process", () => {
    expect(after(["in", "in", "down", "down", "out", "down", "in"])).toEqual({ focus: "task", project: "harbor", task: "north tasks-inbox-sweep", detail: 0 });
  });
});
