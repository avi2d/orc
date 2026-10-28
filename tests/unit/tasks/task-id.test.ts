import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import { decodeOrcShow, decodeTasksReport, mergedTaskLevels, ok, taskLevels } from "@tui-dash/schema";
import { drawTasks, type Navigation, type TasksReadings } from "@tui-dash/tasks";
import { plain } from "@tui-dash/ui";
import { fixture } from "../../lib/fixtures";
import { valueOf } from "../../lib/outcomes";
import { pipelineTaskReadings, southTaskReadings, taskReadings } from "../../lib/task-levels-fixture";

const utc = DateTime.zoneMakeNamedUnsafe("UTC");

const texts = (navigation: Navigation, columns: number, rows: number, value: TasksReadings): ReadonlyArray<string> =>
  drawTasks(value, navigation, columns, rows).block.map(plain);

describe("a task id with its project's prefix", () => {
  const entry = (id: string) => ({
    id,
    title: id,
    project: "orc",
    kind: "build",
    state: "working" as const,
    detail: "",
    startedAt: "2026-10-19T06:00:00.000Z",
    firstStartedAt: "2026-10-19T06:00:00.000Z",
    endedAt: null,
    folders: [],
    branches: [],
  });
  const orc = (...ids: ReadonlyArray<string>): TasksReadings => ({
    levels: taskLevels(
      taskReadings({
        tasks: decodeTasksReport(
          JSON.stringify({
            schemaVersion: 1,
            generatedAt: "2026-10-19T08:02:11.000Z",
            orchestrator: { name: "harbor", version: "0.9.0" },
            tasks: ids.map(entry),
            overhead: [],
            schedules: [],
          }),
        ),
        samples: [],
        live: undefined,
        pueue: undefined,
      }),
    ),
    zone: utc,
  });

  test("the tasks list shows the full id, sized to fit instead of clipped", () => {
    const lines = texts({ focus: "tasks", project: "orc", task: undefined, detail: 0 }, 240, 20, orc("orc-8-resume-by-branch", "orc-9-x"));
    const box = lines.map((line) => line.slice(60, 120));
    expect(box.some((line) => line.includes("orc-8-resume-by-branch"))).toBe(true);
    expect(box.some((line) => line.includes("orc-9-x"))).toBe(true);
    expect(box.every((line) => !line.includes("…"))).toBe(true);
    expect(box.join("\n")).not.toContain("8-resume-by-br…");
  });

  test("the full id keeps the orc run's stage marks in the tasks box", () => {
    const run = { ...entry("orc-8-resume-by-branch"), kind: "orc run", branches: ["fm/orc-step-7"] };
    const value: TasksReadings = {
      levels: taskLevels(
        pipelineTaskReadings({
          tasks: decodeTasksReport(
            JSON.stringify({
              schemaVersion: 1,
              generatedAt: "2026-10-19T08:02:11.000Z",
              orchestrator: { name: "harbor", version: "0.9.0" },
              tasks: [run],
              overhead: [],
              schedules: [],
            }),
          ),
          orc: ok(valueOf(decodeOrcShow(fixture("orc/show.json")))),
        }),
      ),
      zone: utc,
    };
    const lines = texts({ focus: "tasks", project: "orc", task: undefined, detail: 0 }, 120, 20, value).map((line) => line.slice(0, 60));
    const row = lines.find((line) => line.includes("orc-8-resume-by-branch")) ?? "";
    expect(row).toContain("✓✓●○○○○");
    expect(row).toContain("working");
  });

  test("an id wider than the box clips and keeps the state and time", () => {
    const id = "orc-this-task-id-is-deliberately-far-longer-than-the-tasks-box-can-hold";
    const lines = texts({ focus: "tasks", project: "orc", task: undefined, detail: 0 }, 120, 20, orc(id)).map((line) => line.slice(0, 60));
    const head = lines.find((line) => line.includes(" task ")) ?? "";
    const row = lines.find((line) => line.includes("orc-this-task-id")) ?? "";
    expect(row).toContain("…");
    expect(row).toContain("working");
    expect(row).toContain("2h 2m");
    expect(head.indexOf("state")).toBe(row.indexOf("working"));
  });

  test("an id wider than the box leaves its fitting siblings whole", () => {
    const long = "orc-this-task-id-is-deliberately-far-longer-than-the-tasks-box-can-hold-too";
    const lines = texts({ focus: "tasks", project: "orc", task: undefined, detail: 0 }, 120, 20, orc("orc-8-resume-by-branch", long)).map((line) =>
      line.slice(0, 60),
    );
    const fitting = lines.find((line) => line.includes("orc-8-resum")) ?? "";
    const clipped = lines.find((line) => line.includes("orc-this-task-id")) ?? "";
    expect(fitting).toContain("orc-8-resume-by-branch ");
    expect(fitting).not.toContain("…");
    expect(clipped).toContain("…");
    expect(fitting.indexOf("working")).toBe(clipped.indexOf("working"));
  });

  test("on a screen over two machines a long id clips before the machine column drops", () => {
    const id = "orc-resume-by-branch-and-keep-the-workspaces";
    const north = orc(id);
    const both: TasksReadings = { ...north, levels: mergedTaskLevels([north.levels, taskLevels(southTaskReadings())]) };
    const lines = texts({ focus: "tasks", project: "orc", task: undefined, detail: 0 }, 120, 20, both).map((line) => line.slice(0, 60));
    const head = lines.find((line) => line.includes(" task ")) ?? "";
    const row = lines.find((line) => line.includes("orc-resume-by")) ?? "";
    expect(row).toContain("…");
    expect(row).toMatch(/working +north /u);
    expect(head.indexOf("machine")).toBe(row.indexOf("north"));
  });
  test("on a screen over two machines a clipped id keeps the time column", () => {
    const north = orc("orc-resume-by-branch-and-keep-the-workspaces", "orc-9-x");
    const both: TasksReadings = { ...north, levels: mergedTaskLevels([north.levels, taskLevels(southTaskReadings())]) };
    const lines = texts({ focus: "tasks", project: "orc", task: undefined, detail: 0 }, 120, 20, both).map((line) => line.slice(0, 60));
    const head = lines.find((line) => line.includes(" task ")) ?? "";
    const clipped = lines.find((line) => line.includes("orc-resume-by")) ?? "";
    const fitting = lines.find((line) => line.includes("orc-9-x")) ?? "";
    expect(clipped).toContain("…");
    expect(head).toContain("time");
    expect(clipped).toContain("2h 2m");
    expect(fitting).toContain("2h 2m");
  });
  test("at the 30 column minimum a short id keeps the state and machine columns", () => {
    const north = orc("orc-9-x");
    const both: TasksReadings = { ...north, levels: mergedTaskLevels([north.levels, taskLevels(southTaskReadings())]) };
    const lines = texts({ focus: "tasks", project: "orc", task: undefined, detail: 0 }, 30, 20, both).map((line) => line.slice(0, 30));
    const head = lines.find((line) => line.includes(" task ")) ?? "";
    const row = lines.find((line) => line.includes("orc-9-x")) ?? "";
    expect(head).toContain("machine");
    expect(row).toMatch(/working +north /u);
    expect(head.indexOf("machine")).toBe(row.indexOf("north"));
  });
});
