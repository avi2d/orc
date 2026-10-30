import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import {
  decodePueue,
  decodeTasksReport,
  ok,
  taskLevels,
  type TaskSampleRecord,
  unreachable,
} from "@tui-dash/schema";
import { valueOf } from "../../lib/outcomes";
import { fixture } from "../../lib/fixtures";
import { at, gib, live, taskReadings, tasksNow } from "../../lib/task-levels-fixture";

const projectNamed = (levels: ReturnType<typeof taskLevels>, name: string) => {
  const project = levels.projects.find((row) => row.name === name);
  if (project === undefined) throw new Error(`no project ${name}`);
  return project;
};

const taskNamed = (levels: ReturnType<typeof taskLevels>, project: string, id: string) => {
  const task = projectNamed(levels, project).tasks.find((row) => row.id === id);
  if (task === undefined) throw new Error(`no task ${id}`);
  return task;
};

describe("taskLevels joins the tasks report, the kept samples, the live processes and pueue, waited children counted once, each task joined by branch and task id, and a missing source dimming its row rather than clearing it", () => {
  const levels = () => taskLevels(taskReadings());

  test("groups the tasks by project, livest first, with the samples of tasks the report no longer lists", () => {
    expect(levels().projects.map((project) => [project.name, project.tasks.map((task) => [task.id, task.state])])).toEqual([
      [
        "harbor",
        [
          ["tasks-bridge-plot", "working"],
          ["tasks-inbox-sweep", "waiting"],
          ["harbor-gone", "unknown"],
        ],
      ],
    ]);
  });

  test("keeps the CPU a task used across its samples and its live processes, and its largest memory", () => {
    const bridge = taskNamed(levels(), "harbor", "tasks-bridge-plot");
    expect(bridge.cpuSeconds).toBeCloseTo(1001.79, 9);
    expect(bridge.peakBytes).toBe(gib);
    expect(bridge.live?.residentBytes).toBe(148989 * 4096);
    expect(bridge.live?.processes.map((process) => [process.program, process.pid])).toEqual([
      ["pi", 2100],
      ["node", 2300],
      ["git", 2350],
      ["python3", 2900],
      ["cat", 2700],
    ]);
  });

  test("a sampled child that pi has since waited for counts once, in pi's waited children", () => {
    const { before, after } = live().samples;
    const pi = after.find((process) => process.pid === 2100)?.identity ?? "";
    const bun = before.find((process) => process.pid === 2150)?.identity ?? "";
    const reaped: TaskSampleRecord = {
      schemaVersion: 1,
      at: at("2026-10-19T08:00:00Z"),
      machine: { cores: 16, memoryBytes: 47 * gib },
      task: { id: "tasks-bridge-plot", title: "tasks-bridge-plot", project: "harbor", state: "working", firstStartedAt: at("2026-10-18T22:15:00Z"), endedAt: null },
      usage: { processes: [{ identity: bun, ownSeconds: 4, waitedChildSeconds: 0, parent: pi }], cpuCores: 0.5, residentBytes: gib },
      spend: null,
      tests: [],
    };
    expect(taskNamed(taskLevels(taskReadings({ samples: [reaped] })), "harbor", "tasks-bridge-plot").cpuSeconds).toBeCloseTo(601.79, 9);
  });

  test("a task with no sample keeps what its live processes used", () => {
    const inbox = taskNamed(levels(), "harbor", "tasks-inbox-sweep");
    expect(inbox.cpuSeconds).toBeCloseTo(15.5, 9);
    expect(inbox.peakBytes).toBe(50000 * 4096);
  });

  test("an ended task keeps its samples' CPU and memory, and its time runs to its recorded end", () => {
    const fixed: TaskSampleRecord = {
      schemaVersion: 1,
      at: at("2026-10-19T07:02:00Z"),
      machine: { cores: 16, memoryBytes: 47 * gib },
      task: { id: "harbor-day-fix", title: "Day fix", project: "harbor", state: "done", firstStartedAt: at("2026-10-19T06:00:00Z"), endedAt: at("2026-10-19T07:02:00Z") },
      usage: { processes: [{ identity: "1200 2026-10-19T06:00:00Z", ownSeconds: 120 }], cpuCores: 0.5, residentBytes: 2 * gib },
      spend: null,
      tests: [],
    };
    const row = taskNamed(taskLevels(taskReadings({ samples: [fixed] })), "harbor", "harbor-day-fix");
    expect(row).toMatchObject({ state: "done", cpuSeconds: 120, peakBytes: 2 * gib, seconds: 3720, live: undefined });
  });

  test("a task the report no longer lists reads unknown, and its time stops at its last sample", () => {
    expect(taskNamed(levels(), "harbor", "harbor-gone")).toMatchObject({ state: "unknown", seconds: 3600, endedAt: at("2026-10-19T06:00:00Z") });
  });

  test("a running task's time runs to now from its first start", () => {
    expect(taskNamed(levels(), "harbor", "tasks-bridge-plot").seconds).toBe(9 * 3600 + 47 * 60 + 11);
  });

  test("gives each pueue run to the task that owned its folder when it started, newest first", () => {
    const tests = (id: string, project = "harbor") => taskNamed(levels(), project, id).tests.map((run) => run.id);
    expect(tests("tasks-bridge-plot")).toEqual([1, 2]);
    expect(tests("tasks-inbox-sweep")).toEqual([4]);
    const notesToday = taskLevels(
      taskReadings({ tasks: decodeTasksReport(fixture("tasks/east.json").replace("2026-10-18T15:30:00.000Z", "2026-10-19T07:30:00.000Z")) }),
    );
    expect(taskNamed(notesToday, "notes", "tasks-release-notes").tests.map((run) => run.id)).toEqual([3]);
    expect(taskNamed(levels(), "harbor", "tasks-bridge-plot").testSeconds).toBe(110);
    expect(taskNamed(levels(), "harbor", "tasks-inbox-sweep").testSeconds).toBe(131);
  });

  test("counts each project's tasks by live state, and its time is its longest-running live task", () => {
    const harbor = projectNamed(levels(), "harbor");
    expect(harbor).toMatchObject({ working: 1, waiting: 1, parked: 0, blocked: 0, residentBytes: (148989 + 50000) * 4096 });
    expect(harbor.cpuSeconds).toBeCloseTo(1001.79 + 15.5 + 30, 9);
    expect(harbor.seconds).toBe(9 * 3600 + 47 * 60 + 11);
    expect(levels().projects.map((project) => project.name)).not.toContain("notes");
  });

  test("sorts the projects by live count, then by working count, then by name", () => {
    expect(levels().projects.map((project) => project.name)).toEqual(["harbor"]);
  });
});

describe("taskLevels counts the website variant, a quiet project kept on the list with no time", () => {
  const entry = (id: string, project: string, state: "working" | "waiting" | "done", firstStartedAt: string, endedAt: string | null) =>
    ({
      id,
      title: id,
      project,
      kind: "build",
      state,
      detail: "",
      startedAt: firstStartedAt,
      firstStartedAt,
      endedAt,
      folders: [],
      branches: [],
    });
  const variant = () =>
    taskLevels(
      taskReadings({
        tasks: decodeTasksReport(
          JSON.stringify({
            schemaVersion: 1,
            generatedAt: "2026-10-19T08:02:11.000Z",
            orchestrator: { name: "harbor", version: "0.9.0" },
            tasks: [
              entry("website-a", "website", "working", "2026-10-19T05:32:11.000Z", null),
              entry("website-b", "website", "working", "2026-10-19T07:00:00.000Z", null),
              entry("website-c", "website", "working", "2026-10-19T07:30:00.000Z", null),
              entry("website-d", "website", "waiting", "2026-10-19T06:00:00.000Z", null),
              entry("checks-a", "checks", "working", "2026-10-19T07:54:11.000Z", null),
              entry("socials-a", "socials", "waiting", "2026-10-19T07:00:00.000Z", null),
              entry("dotfiles-a", "dotfiles", "done", "2026-10-19T06:00:00.000Z", "2026-10-19T07:00:00.000Z"),
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

  test("lists every project, livest first, with each live state counted and time longest live", () => {
    const levels = variant();
    expect(levels.projects.map((project) => project.name)).toEqual(["website", "checks", "socials", "dotfiles"]);
    expect(projectNamed(levels, "website")).toMatchObject({ working: 3, waiting: 1, parked: 0, blocked: 0, seconds: 2 * 3600 + 30 * 60 });
    expect(projectNamed(levels, "checks")).toMatchObject({ working: 1, waiting: 0, parked: 0, blocked: 0, seconds: 8 * 60 });
    expect(projectNamed(levels, "socials")).toMatchObject({ working: 0, waiting: 1, parked: 0, blocked: 0 });
    expect(projectNamed(levels, "dotfiles")).toMatchObject({ working: 0, waiting: 0, parked: 0, blocked: 0, seconds: undefined });
  });
});

describe("taskLevels lists the registered projects, a quiet one kept and given no time of another's", () => {
  const registered = (names: ReadonlyArray<string>, report = fixture("tasks/east.json")) => {
    const read = valueOf(decodeTasksReport(report));
    return taskLevels(taskReadings({ tasks: { kind: "ok", value: { generatedAt: read.generatedAt, view: { ...read.view, registered: names } } } }));
  };

  test("a registered project with no task in the window keeps an idle row", () => {
    const levels = registered(["harbor", "notes", "skills"]);
    expect(levels.registered).toEqual(["harbor", "notes", "skills"]);
    expect(levels.projects.map((project) => project.name)).toEqual(["harbor", "notes", "skills"]);
    expect(projectNamed(levels, "skills")).toMatchObject({
      working: 0,
      waiting: 0,
      parked: 0,
      blocked: 0,
      ready: 0,
      held: 0,
      seconds: undefined,
      tasks: [],
      planned: [],
    });
  });

  test("a registered project keeps its row after its last task leaves the window", () => {
    const report = fixture("tasks/east.json").replace("2026-10-18T15:30:00.000Z", "2026-10-12T08:02:10.000Z");
    const levels = registered(["notes"], report);
    expect(levels.projects.map((project) => project.name)).toEqual(["harbor", "notes"]);
    expect(projectNamed(levels, "notes").tasks).toEqual([]);
  });
});

describe("taskLevels keeps the done tasks of the current day, not yesterday's or one that ended long ago", () => {
  const notesEnded = (iso: string) =>
    taskLevels(taskReadings({ tasks: decodeTasksReport(fixture("tasks/east.json").replace("2026-10-18T15:30:00.000Z", iso)) }));

  test("a reported task that ended today counts, and one that ended yesterday does not", () => {
    expect(projectNamed(notesEnded("2026-10-19T07:30:00.000Z"), "notes").tasks.map((task) => task.id)).toEqual(["tasks-release-notes"]);
    expect(notesEnded("2026-10-18T23:59:59.000Z").projects.map((project) => project.name)).toEqual(["harbor"]);
  });

  test("the current day follows the display zone, not UTC", () => {
    const zone = DateTime.zoneMakeNamedUnsafe("Europe/Moscow");
    const reported = (now: string, endedAt: string) =>
      taskLevels(
        taskReadings({
          tasks: decodeTasksReport(fixture("tasks/east.json").replace("2026-10-18T15:30:00.000Z", endedAt)),
          samples: [],
          now: at(now),
          zone,
        }),
      );
    expect(projectNamed(reported("2026-10-19T05:00:00Z", "2026-10-18T21:15:00.000Z"), "notes").tasks.map((task) => task.id)).toEqual([
      "tasks-release-notes",
    ]);
    expect(reported("2026-10-18T22:00:00Z", "2026-10-18T20:30:00.000Z").projects.map((project) => project.name)).not.toContain("notes");
  });

  test("a sampled task that ended after local midnight counts though UTC calls it yesterday", () => {
    const sample: TaskSampleRecord = {
      schemaVersion: 1,
      at: at("2026-10-19T04:00:00Z"),
      machine: { cores: 16, memoryBytes: 47 * gib },
      task: {
        id: "harbor-local",
        title: "Local",
        project: "harbor",
        state: "done",
        firstStartedAt: at("2026-10-18T20:00:00Z"),
        endedAt: at("2026-10-18T21:15:00.000Z"),
      },
      usage: null,
      spend: null,
      tests: [],
    };
    const tasks = taskLevels(
      taskReadings({ samples: [sample], now: at("2026-10-19T05:00:00Z"), zone: DateTime.zoneMakeNamedUnsafe("Europe/Moscow") }),
    ).projects.flatMap((project) => project.tasks.map((task) => task.id));
    expect(tasks).toContain("harbor-local");
  });

  test("a done task hidden by the cutoff keeps its queue attribution", () => {
    const levels = taskLevels(
      taskReadings({
        tasks: decodeTasksReport(
          JSON.stringify({
            schemaVersion: 1,
            generatedAt: "2026-10-19T08:02:11.000Z",
            orchestrator: { name: "harbor", version: "0.9.0" },
            tasks: [
              {
                id: "alpha",
                title: "alpha",
                project: "harbor",
                kind: "build",
                state: "done",
                detail: "",
                startedAt: "2026-10-18T22:00:00.000Z",
                firstStartedAt: "2026-10-18T22:00:00.000Z",
                endedAt: "2026-10-18T23:00:00.000Z",
                folders: ["/work/a"],
                branches: [],
              },
            ],
            overhead: [],
            schedules: [],
          }),
        ),
        pueue: decodePueue(
          JSON.stringify({
            groups: { default: { status: "Running", parallel_tasks: 1 } },
            tasks: {
              "7": {
                id: 7,
                command: "bun test",
                path: "/work/a",
                status: { Done: { start: "2026-10-18T22:30:00Z", end: "2026-10-18T22:35:00Z", result: "Success" } },
              },
            },
          }),
        ),
        samples: [],
        live: undefined,
      }),
    );
    expect(levels.projects.flatMap((project) => project.tasks.map((task) => task.id))).not.toContain("alpha");
    expect(levels.runOwners.get(7)).toBe("alpha");
  });

  test("a sampled task that ended before today does not count, though its sample is from today", () => {
    const restamped: TaskSampleRecord = {
      schemaVersion: 1,
      at: at("2026-10-19T08:00:00Z"),
      machine: { cores: 16, memoryBytes: 47 * gib },
      task: { id: "harbor-stale", title: "Stale", project: "harbor", state: "done", firstStartedAt: at("2026-10-01T09:00:00Z"), endedAt: at("2026-10-02T09:00:00Z") },
      usage: null,
      spend: null,
      tests: [],
    };
    const tasks = taskLevels(taskReadings({ samples: [restamped] })).projects.flatMap((project) => project.tasks.map((task) => task.id));
    expect(tasks).not.toContain("harbor-stale");
    expect(tasks).toContain("tasks-bridge-plot");
  });
});

describe("taskLevels sorts done tasks newest first", () => {
  test("a later end reads before an earlier one", () => {
    const entry = (id: string, endedAt: string) => ({
      id,
      title: id,
      project: "harbor",
      kind: "build",
      state: "done" as const,
      detail: "",
      startedAt: "2026-10-19T05:00:00.000Z",
      firstStartedAt: "2026-10-19T05:00:00.000Z",
      endedAt,
      folders: [],
      branches: [],
    });
    const levels = taskLevels(
      taskReadings({
        tasks: decodeTasksReport(
          JSON.stringify({
            schemaVersion: 1,
            generatedAt: "2026-10-19T08:02:11.000Z",
            orchestrator: { name: "harbor", version: "0.9.0" },
            tasks: [entry("alpha", "2026-10-19T06:00:00.000Z"), entry("zeta", "2026-10-19T07:00:00.000Z")],
            overhead: [],
            schedules: [],
          }),
        ),
        samples: [],
        live: undefined,
        pueue: undefined,
      }),
    );
    expect(projectNamed(levels, "harbor").tasks.map((task) => task.id)).toEqual(["zeta", "alpha"]);
  });

  test("tasks without a recorded end keep id order", () => {
    const missing = (id: string, iso: string): TaskSampleRecord => ({
      schemaVersion: 1,
      at: at(iso),
      machine: { cores: 16, memoryBytes: 47 * gib },
      task: { id, title: id, project: "harbor", state: "working", firstStartedAt: at("2026-10-19T05:00:00Z"), endedAt: null },
      usage: null,
      spend: null,
      tests: [],
    });
    const levels = taskLevels(taskReadings({ samples: [missing("alpha", "2026-10-19T06:00:00Z"), missing("zeta", "2026-10-19T07:00:00Z")] }));
    expect(
      projectNamed(levels, "harbor")
        .tasks.filter((task) => task.state === "unknown")
        .map((task) => task.id),
    ).toEqual(["alpha", "zeta"]);
  });

  test("done tasks sort before tasks without a recorded end in a mixed sequence", () => {
    const entry = (id: string, endedAt: string) => ({
      id,
      title: id,
      project: "harbor",
      kind: "build",
      state: "done" as const,
      detail: "",
      startedAt: "2026-10-19T05:00:00.000Z",
      firstStartedAt: "2026-10-19T05:00:00.000Z",
      endedAt,
      folders: [],
      branches: [],
    });
    const history = (id: string, iso: string, endedAt: string | null): TaskSampleRecord => ({
      schemaVersion: 1,
      at: at(iso),
      machine: { cores: 16, memoryBytes: 47 * gib },
      task: { id, title: id, project: "harbor", state: endedAt === null ? "working" : "done", firstStartedAt: at("2026-10-19T05:00:00Z"), endedAt: endedAt === null ? null : at(endedAt) },
      usage: null,
      spend: null,
      tests: [],
    });
    const levels = taskLevels(
      taskReadings({
        tasks: decodeTasksReport(
          JSON.stringify({
            schemaVersion: 1,
            generatedAt: "2026-10-19T08:02:11.000Z",
            orchestrator: { name: "harbor", version: "0.9.0" },
            tasks: [entry("alpha", "2026-10-19T06:00:00.000Z")],
            overhead: [],
            schedules: [],
          }),
        ),
        samples: [history("mu", "2026-10-19T06:30:00Z", null), history("zeta", "2026-10-19T07:30:00Z", "2026-10-19T07:00:00.000Z")],
        live: undefined,
        pueue: undefined,
      }),
    );
    expect(projectNamed(levels, "harbor").tasks.map((task) => task.id)).toEqual(["zeta", "alpha", "mu"]);
  });
});

describe("taskLevels flags and failures, a flag past a quarter, and a failed read keeping the projects", () => {
  test("a task holding more than a quarter of memory now is over now", () => {
    const bridge = taskNamed(taskLevels(taskReadings({ live: ok(live(2 * gib)) })), "harbor", "tasks-bridge-plot");
    expect(bridge.episodes).toEqual([{ limit: "memory", from: tasksNow, to: tasksNow, ongoing: true }]);
    expect(taskNamed(taskLevels(taskReadings()), "harbor", "tasks-bridge-plot").episodes).toEqual([]);
  });

  test("a source that fails is named, and the others still read", () => {
    const levels = taskLevels(taskReadings({ pueue: unreachable("pueue gave no answer within 10 seconds") }));
    expect(levels.failures).toEqual([{ source: "pueue", failure: { kind: "unreachable", reason: "pueue gave no answer within 10 seconds" } }]);
    expect(taskNamed(levels, "harbor", "tasks-bridge-plot").tests).toEqual([]);
    expect(taskNamed(levels, "harbor", "tasks-bridge-plot").live?.processes).toHaveLength(5);
  });

  test("before the report answers, the levels are pending and the sampled tasks keep their recorded state", () => {
    const levels = taskLevels(taskReadings({ tasks: { kind: "pending" } }));
    expect(levels.pending).toBe(true);
    expect(taskNamed(levels, "harbor", "harbor-gone").state).toBe("working");
  });

  test("with no tasks command, the sampled tasks keep their recorded state and nothing reads as failed", () => {
    const levels = taskLevels(taskReadings({ tasks: { kind: "unset" } }));
    expect(levels).toMatchObject({ pending: false, unset: true, failures: [] });
    expect(taskNamed(levels, "harbor", "harbor-gone").state).toBe("working");
  });
});

