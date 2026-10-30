import { DateTime } from "effect";
import {
  decodeLinuxTaskProcesses,
  decodeNoMistakes,
  decodeOrcShow,
  decodeTasksReport,
  historyDays,
  type LiveTasks,
  ok,
  type PueueStatus,
  type SampledProcess,
  taskLevels,
  type TaskLevelReadings,
  type TaskLevels,
  type TaskSampleRecord,
  type TaskSpend,
} from "@tui-dash/schema";
import { fixture } from "./fixtures";
import { valueOf } from "./outcomes";

export const gib = 1024 ** 3;

const utc = DateTime.zoneMakeNamedUnsafe("UTC");

export const notesEndedToday = (): TaskLevelReadings =>
  taskReadings({
    tasks: decodeTasksReport(
      fixture("tasks/east.json").replaceAll("2026-10-18T09:00:00.000Z", "2026-10-19T06:00:00.000Z").replace("2026-10-18T15:30:00.000Z", "2026-10-19T07:30:00.000Z"),
    ),
  });

const endedEntry = (id: string, endedAt: string) => ({
  id,
  title: id,
  project: "harbor",
  kind: "build",
  state: "done" as const,
  detail: "",
  startedAt: "2026-10-19T04:00:00.000Z",
  firstStartedAt: "2026-10-19T04:00:00.000Z",
  endedAt,
  folders: [],
  branches: [],
});

export const harborCrowdedToday = (): TaskLevelReadings =>
  taskReadings({
    tasks: decodeTasksReport(
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: "2026-10-19T08:02:11.000Z",
        orchestrator: { name: "harbor", version: "0.9.0" },
        tasks: [
          {
            id: "tasks-bridge-plot",
            title: "Plot the bridge migration",
            project: "harbor",
            kind: "build",
            state: "working",
            detail: "",
            startedAt: "2026-10-19T07:41:00.000Z",
            firstStartedAt: "2026-10-18T22:15:00.000Z",
            endedAt: null,
            folders: [],
            branches: [],
          },
          {
            id: "tasks-inbox-sweep",
            title: "Sweep the inbox",
            project: "harbor",
            kind: "review",
            state: "waiting",
            detail: "",
            startedAt: "2026-10-19T06:00:00.000Z",
            firstStartedAt: "2026-10-19T06:00:00.000Z",
            endedAt: null,
            folders: [],
            branches: [],
          },
          endedEntry("harbor-day-a", "2026-10-19T05:00:00.000Z"),
          endedEntry("harbor-day-b", "2026-10-19T06:30:00.000Z"),
          endedEntry("harbor-day-c", "2026-10-19T07:30:00.000Z"),
        ],
        overhead: [],
        schedules: [],
      }),
    ),
  });

export const withSpend = (spend: TaskSpend): { readonly levels: TaskLevels; readonly zone: DateTime.TimeZone } => {
  const levels = taskLevels(taskReadings());
  return {
    levels: {
      ...levels,
      projects: levels.projects.map((project) => ({
        ...project,
        tasks: project.tasks.map((row) => (row.id === "tasks-bridge-plot" ? { ...row, spend } : row)),
      })),
    },
    zone: utc,
  };
};

export const tasksNow = DateTime.makeUnsafe("2026-10-19T08:02:11Z");

export const at = (iso: string): DateTime.Utc => DateTime.makeUnsafe(iso);

const machine = { cores: 16, memoryBytes: 47 * gib };

const sampled = (
  id: string,
  iso: string,
  process: SampledProcess | null,
  task: Partial<TaskSampleRecord["task"]> = {},
  residentBytes = gib,
): TaskSampleRecord => ({
  schemaVersion: 1,
  at: at(iso),
  machine,
  task: { id, title: id, project: "harbor", state: "working", firstStartedAt: at("2026-10-16T09:00:00Z"), endedAt: null, ...task },
  usage: process === null ? null : { processes: [process], cpuCores: 0.5, residentBytes },
  spend: null,
  tests: [],
});

const processFrom = (pid: number, iso: string, ownSeconds: number): SampledProcess => ({ identity: String(pid) + " " + iso, ownSeconds });

const bridgeStart = { firstStartedAt: at("2026-10-18T22:15:00Z") };

const liveSamples = () => valueOf(decodeLinuxTaskProcesses(fixture("linux/task-processes.txt")));

const piIdentity = liveSamples().after.find((process) => process.pid === 2100)?.identity ?? "";

const samples: ReadonlyArray<TaskSampleRecord> = [
  sampled("tasks-bridge-plot", "2026-10-19T07:00:00Z", processFrom(1900, "2026-10-19T06:00:00Z", 300), bridgeStart),
  sampled("tasks-bridge-plot", "2026-10-19T07:30:00Z", processFrom(1950, "2026-10-19T07:10:00Z", 100), bridgeStart),
  sampled("tasks-bridge-plot", "2026-10-19T08:00:00Z", { identity: piIdentity, ownSeconds: 500 }, bridgeStart),
  sampled("harbor-old-fix", "2026-10-16T10:00:00Z", processFrom(1200, "2026-10-16T09:00:00Z", 60), {}, 2 * gib),
  sampled("harbor-old-fix", "2026-10-16T10:01:00Z", processFrom(1200, "2026-10-16T09:00:00Z", 120), {}, 2 * gib),
  sampled("harbor-old-fix", "2026-10-16T10:02:00Z", null, { state: "done", endedAt: at("2026-10-16T10:02:00Z") }),
  sampled("harbor-gone", "2026-10-19T06:00:00Z", processFrom(1300, "2026-10-19T05:00:00Z", 30), { firstStartedAt: at("2026-10-19T05:00:00Z") }),
  sampled("harbor-ancient", "2026-10-11T10:00:00Z", processFrom(1400, "2026-10-11T09:00:00Z", 30)),
];

const done = (path: string, command: string, start: string, end: string, result: "Success" | { readonly Failed: number }) => ({
  command,
  path,
  status: { Done: { start: at(start), end: at(end), result } },
});

const pueue: PueueStatus = {
  groups: { default: { status: "Running", parallel_tasks: 1 } },
  tasks: {
    "1": { id: 1, ...done("/home/example/.no-mistakes/worktrees/a1b2c3/run-7", "bun test", "2026-10-19T07:55:00Z", "2026-10-19T07:56:30Z", "Success") },
    "2": { id: 2, ...done("/home/example/work/harbor", "bun run lint", "2026-10-19T05:00:00Z", "2026-10-19T05:00:20Z", { Failed: 1 }) },
    "3": { id: 3, ...done("/home/example/work/notes", "bun test", "2026-10-18T10:00:00Z", "2026-10-18T10:01:00Z", "Success") },
    "4": { id: 4, command: "bun test --watch", path: "/home/example/work/harbor", status: { Running: { start: at("2026-10-19T08:00:00Z") } } },
    "5": { id: 5, ...done("/home/example/elsewhere", "true", "2026-10-19T07:00:00Z", "2026-10-19T07:00:01Z", "Success") },
  },
};

const programs = new Map([
  [2100, "pi"],
  [2200, "bun"],
  [2300, "node"],
  [2350, "git"],
  [2500, "vim"],
  [2700, "cat"],
  [2900, "python3"],
]);

export const live = (memoryBytes = 47 * gib): LiveTasks => ({
  samples: liveSamples(),
  programs,
  memoryBytes,
});

// The pipeline report is a third hand-written oracle, where pipe-full joins the recorded no-mistakes run on its branch,
// orc-step-7 joins the captured orc show output on its branch, and the other tasks read their own detail lines.
export const pipelineTaskReadings = (overrides: Partial<TaskLevelReadings> = {}): TaskLevelReadings =>
  taskReadings({
    tasks: decodeTasksReport(fixture("tasks/pipeline.json")),
    samples: [],
    live: undefined,
    pueue: undefined,
    noMistakes: ok(valueOf(decodeNoMistakes(fixture("no-mistakes/run.txt")))),
    orc: ok(valueOf(decodeOrcShow(fixture("orc/show.json")))),
    ...overrides,
  });

// South's report is a second hand-written oracle, with its own project, so a screen showing kelp is reading the other machine.
export const southTaskReadings = (overrides: Partial<TaskLevelReadings> = {}): TaskLevelReadings => ({
  ...taskReadings(),
  machine: "south",
  origin: "remote",
  tasks: decodeTasksReport(fixture("tasks/south.json")),
  samples: [],
  live: undefined,
  liveConfigured: false,
  ...overrides,
});

export const taskReadings = (overrides: Partial<TaskLevelReadings> = {}): TaskLevelReadings => ({
  machine: "north",
  origin: "local",
  tasks: decodeTasksReport(fixture("tasks/east.json")),
  samples,
  live: ok(live()),
  liveConfigured: true,
  pueue: ok(pueue),
  noMistakes: undefined,
  orc: undefined,
  sessions: undefined,
  now: tasksNow,
  days: historyDays,
  zone: utc,
  ...overrides,
});
