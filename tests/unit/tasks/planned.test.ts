import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import { decodeTasksReport, mergedTaskLevels, type ProjectRow, taskLevels } from "@tui-dash/schema";
import { drawTasks, moved, type Navigation, listedIdOf, listedRows, pickedTask, type TasksReadings } from "@tui-dash/tasks";
import { plain } from "@tui-dash/ui";
import { fixture } from "../../lib/fixtures";
import { southTaskReadings, taskReadings } from "../../lib/task-levels-fixture";

const utc = DateTime.zoneMakeNamedUnsafe("UTC");

const readings = (overrides: Parameters<typeof taskReadings>[0] = {}): TasksReadings => ({
  levels: taskLevels(taskReadings(overrides)),
  zone: utc,
});

const onProjects: Navigation = { focus: "projects", project: undefined, task: undefined, detail: 0 };

const drawn = (navigation: Navigation, columns = 120, rows = 20, value = readings()) => drawTasks(value, navigation, columns, rows);

const texts = (navigation: Navigation, columns = 120, rows = 20, value = readings()): ReadonlyArray<string> =>
  drawn(navigation, columns, rows, value).block.map(plain);

const task = (id: string, state: "working" | "waiting" | "parked" | "blocked" | "done") => ({
  id,
  title: id,
  project: "harbor",
  kind: "quick fix",
  state,
  detail: "",
  startedAt: "2026-10-19T07:00:00.000Z",
  firstStartedAt: "2026-10-19T07:00:00.000Z",
  endedAt: state === "done" ? "2026-10-19T07:30:00.000Z" : null,
  folders: [],
  branches: [],
});

const planned = (id: string, home: string, hold: { kind: string; reason: string } | null, after: ReadonlyArray<string>) => ({
  id,
  title: id,
  project: "harbor",
  kind: "ship",
  home,
  queuedOn: "2026-10-18T00:00:00Z",
  hold,
  after,
});

const harborLevels = (ownerKind = "owner") =>
  taskLevels(
    taskReadings({
      tasks: decodeTasksReport(
        JSON.stringify({
          schemaVersion: 1,
          generatedAt: "2026-10-19T08:02:11.000Z",
          orchestrator: { name: "harbor", version: "0.9.0" },
          tasks: [task("harbor-done", "done"), task("harbor-parked", "parked"), task("harbor-wait", "waiting"), task("harbor-run", "working"), task("harbor-stuck", "blocked")],
          planned: [
            planned("harbor-first", "north", null, []),
            planned("harbor-other-home", "south", null, []),
            planned("harbor-second", "north", null, []),
            planned("harbor-asked", "north", { kind: ownerKind, reason: "waits on a pick" }, []),
            planned("harbor-chained", "north", null, ["harbor-run"]),
          ],
          overhead: [],
          schedules: [],
        }),
      ),
      samples: [],
      live: undefined,
      pueue: undefined,
    }),
  );

const harbor = (): ProjectRow => {
  const project = harborLevels().projects.find((row) => row.name === "harbor");
  if (project === undefined) throw new Error("no harbor project");
  return project;
};

describe("planned rows from the report", () => {
  test("count ready apart from held and number each home's ready rows on their own", () => {
    const project = harbor();
    expect(project).toMatchObject({ ready: 3, held: 2 });
    expect(project.planned.map((row) => [row.id, row.next])).toEqual([
      ["harbor-first", 1],
      ["harbor-other-home", 1],
      ["harbor-second", 2],
      ["harbor-asked", undefined],
      ["harbor-chained", undefined],
    ]);
  });
});

// The public repo's rule: no message names a persona.
describe("a planned ticket held for the reader", () => {
  test("says it is held for you and gives the reason", () => {
    const lines = drawTasks({ levels: harborLevels(), zone: utc }, { focus: "task", project: "harbor", task: "north harbor-asked", detail: 0 }, 120, 30).block.map(plain);
    expect(lines.some((line) => line.includes("\u2298 held for you"))).toBe(true);
    expect(lines.some((line) => line.includes("waits on a pick"))).toBe(true);
    expect(lines.join("\n").toLowerCase()).not.toContain("owner");
  });

  test("still says held for you when the reporter sends the hold under its older kind, rather than failing the report", () => {
    const lines = drawTasks({ levels: harborLevels("captain"), zone: utc }, { focus: "task", project: "harbor", task: "north harbor-asked", detail: 0 }, 120, 30).block.map(plain);
    expect(lines.some((line) => line.includes("\u2298 held for you"))).toBe(true);
  });
});

describe("the proposed task sort", () => {
  test("puts live work, then waiting, then ready rows in dispatch order, then held rows, then ended tasks", () => {
    expect(listedRows(harbor()).map(listedIdOf)).toEqual([
      "north harbor-run",
      "north harbor-wait",
      "north harbor-stuck",
      "north harbor-parked",
      "north harbor-first",
      "north harbor-other-home",
      "north harbor-second",
      "north harbor-asked",
      "north harbor-chained",
      "north harbor-done",
    ]);
  });
});

describe("the projects total", () => {
  const plannedNotes = (): TasksReadings => {
    const queued = (id: string, hold: { kind: "owner"; reason: string } | null) => ({
      id,
      title: id,
      project: "notes",
      kind: "ship",
      home: "north",
      queuedOn: "2026-10-18T00:00:00Z",
      hold,
      after: [],
    });
    const items = [queued("notes-next", null), queued("notes-asked", { kind: "owner", reason: "waits on a pick" })];
    const report = fixture("tasks/east.json").trimEnd().replace(/\}$/u, `,"planned":${JSON.stringify(items)}}`);
    return readings({ tasks: decodeTasksReport(report) });
  };

  test("totals the shown figures under the header once two projects have any", () => {
    const lines = texts(onProjects, 120, 20, plannedNotes()).slice(3, 6).map((line) => line.slice(0, 60));
    expect(lines).toEqual([
      expect.stringMatching(/total +1 +1 +– +– +– +1\+1/u),
      expect.stringMatching(/harbor +1 +1 +– +– +– +–/u),
      expect.stringMatching(/notes +– +– +– +– +– +1\+1/u),
    ]);
    const total = drawn(onProjects, 120, 20, plannedNotes()).block[3] ?? [];
    expect(total.filter((part) => part.text.trim() === "1").map((part) => part.style.tone)).toEqual(["primary", "warning", "accent"]);
  });

  test("draws no total when one project alone has figures", () => {
    const { levels } = readings();
    const kept = levels.projects.find((row) => row.name === "harbor");
    if (kept === undefined) throw new Error("no harbor project");
    const lines = texts(onProjects, 120, 20, { levels: { ...levels, projects: [kept] }, zone: utc });
    expect(lines[3]).toMatch(/harbor +1 +1 +– +– +–/u);
    expect(lines.slice(3).some((line) => /total/.test(line))).toBe(false);
  });
});

describe("the no-project row", () => {
  const adrift = (): TasksReadings => {
    const report = JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-10-19T08:02:11.000Z",
      orchestrator: { name: "harbor", version: "0.9.0" },
      tasks: [{ ...task("adrift-done", "done"), project: "?" }],
      planned: [{ ...planned("adrift-next", "north", null, []), project: "?" }],
      overhead: [],
      schedules: [],
    });
    return readings({ tasks: decodeTasksReport(report), samples: [], live: undefined, pueue: undefined });
  };

  test("names the ? project no project and keeps its task and planned rows", () => {
    const { levels } = adrift();
    expect(levels.projects.map((project) => project.name)).toEqual(["?"]);
    expect(levels.projects[0]?.tasks.map((row) => row.id)).toEqual(["adrift-done"]);
    expect(levels.projects[0]?.planned.map((row) => row.id)).toEqual(["adrift-next"]);
    const lines = texts(onProjects, 120, 20, adrift());
    expect(lines.some((line) => line.includes("no project"))).toBe(true);
    expect(lines.some((line) => /(^|\s)\?(\s|$)/u.test(line))).toBe(false);
  });
});

describe("a planned row on a screen over two machines", () => {
  test("names the machine whose report queues it", () => {
    const levels = mergedTaskLevels([harborLevels(), taskLevels(southTaskReadings())]);
    const lines = texts({ focus: "tasks", project: "harbor", task: undefined, detail: 0 }, 120, 30, { levels, zone: utc }).map((line) => line.slice(0, 60));
    expect(lines.find((line) => line.includes("harbor-first"))).toMatch(/harbor-first +planned +north /u);
    expect(lines.find((line) => line.includes("harbor-other-home"))).toMatch(/harbor-other-home +planned +north /u);
    expect(lines.find((line) => line.includes("harbor-asked"))).toMatch(/harbor-asked +held +north /u);
  });
  test("down from one machine's copy of a queued id reaches the other machine's copy and each opens its own row", () => {
    const queued = {
      id: "harbor-next",
      title: "harbor-next",
      project: "harbor",
      kind: "ship",
      home: "north",
      queuedOn: "2026-10-18T00:00:00Z",
      hold: null,
      after: [],
    };
    const report = JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-10-19T08:02:11.000Z",
      orchestrator: { name: "harbor", version: "0.9.0" },
      tasks: [],
      planned: [queued],
      overhead: [],
      schedules: [],
    });
    const north = taskLevels(taskReadings({ tasks: decodeTasksReport(report), samples: [], live: undefined, pueue: undefined }));
    const south = taskLevels(taskReadings({ machine: "south", tasks: decodeTasksReport(report), samples: [], live: undefined, pueue: undefined }));
    const levels = mergedTaskLevels([north, south]);
    const project = levels.projects.find((row) => row.name === "harbor");
    if (project === undefined) throw new Error("no harbor project");
    expect(listedRows(project).map(listedIdOf)).toEqual(["north harbor-next", "south harbor-next"]);
    const first: Navigation = { focus: "tasks", project: "harbor", task: "north harbor-next", detail: 0 };
    const second = moved(levels, first, "down");
    expect(second.task).toBe("south harbor-next");
    expect(pickedTask(project, second)?.kind === "planned" && pickedTask(project, second)).toMatchObject({ planned: { id: "harbor-next", machine: "south" } });
    const { targets } = drawTasks({ levels, zone: utc }, { focus: "tasks", project: "harbor", task: undefined, detail: 0 }, 120, 20);
    expect([...new Set(targets.map((target) => target.state.task).filter((key): key is string => key?.endsWith("harbor-next") === true))].toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0))).toEqual(["north harbor-next", "south harbor-next"]);
  });
});
