import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import { decodeTasksReport, taskLevels } from "@tui-dash/schema";
import { drawTasks, type Navigation, type TasksReadings } from "@tui-dash/tasks";
import { plain } from "@tui-dash/ui";
import { fixture } from "../../lib/fixtures";
import { valueOf } from "../../lib/outcomes";
import { taskReadings } from "../../lib/task-levels-fixture";

const utc = DateTime.zoneMakeNamedUnsafe("UTC");

const onProjects: Navigation = { focus: "projects", project: undefined, task: undefined, detail: 0 };

const lines = (): ReadonlyArray<string> => {
  const read = valueOf(decodeTasksReport(fixture("tasks/east.json")));
  const value: TasksReadings = {
    levels: taskLevels(
      taskReadings({ tasks: { kind: "ok", value: { generatedAt: read.generatedAt, view: { ...read.view, registered: ["harbor", "notes", "skills"] } } } }),
    ),
    zone: utc,
  };
  return drawTasks(value, onProjects, 120, 20).block.map(plain);
};

describe("the projects box with a registry", () => {
  test("titles the box projects and lists the quiet registered project", () => {
    const text = lines();
    expect(text[1]).toContain(" projects ");
    expect(text[1]).not.toContain("last 7 days");
    expect(text.join("\n")).toContain("skills");
  });
});
