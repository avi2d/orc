import { DateTime, Option } from "effect";
import { mapOutcome, type Outcome } from "../reading";
import type { ActionRun } from "../sources/actions";
import type { PueueGroupStatus, PueueStatus, PueueTask, PueueTaskResult } from "../sources/pueue";
import { type MachineProjects, type ProjectNames, unknownProject } from "../sources/project-names";

export type FailureView =
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "spawn"; readonly error: string }
  | { readonly kind: "killed" }
  | { readonly kind: "errored" }
  | { readonly kind: "dependency" };

type RunResult = { readonly kind: "success" } | FailureView;

export interface RunningRow {
  readonly id: number;
  readonly command: string;
  readonly path: string;
  readonly project: string;
  readonly startedAt: DateTime.Utc;
}

export interface EndedRow extends RunningRow {
  readonly endedAt: DateTime.Utc;
  readonly result: RunResult;
}

export type TestRun = RunningRow | EndedRow;

export type RunOwners = ReadonlyMap<number, string>;

export interface GroupView {
  readonly name: string;
  readonly status: PueueGroupStatus;
  readonly parallel: number;
}

export interface PueueView {
  readonly running: ReadonlyArray<RunningRow>;
  readonly ended: ReadonlyArray<EndedRow>;
  readonly queued: number;
  readonly paused: number;
  readonly groups: ReadonlyArray<GroupView>;
}

const homeDirectory = /^\/(?:home\/[^/]+|Users\/[^/]+|root)$/u;

// A subfolder of a scratch folder, such as gotmp, says nothing of whose run it was.
const scratchFolder = /^(?:\/private)?\/tmp\/([^/]+)/u;

const treehouseRepository = /\/\.treehouse\/[^/]+\/[^/]+\/([^/]+)/u;

// A no-mistakes run copy ends in its run id, not its project.
const runCopy = /\/\.no-mistakes\/worktrees\//u;

export const copyPathsOfStatus = (status: PueueStatus): ReadonlyArray<string> => [
  ...new Set(Object.values(status.tasks).flatMap((task) => (runCopy.test(task.path) ? [task.path] : []))),
];

export const projectOf = (path: string): string => {
  if (homeDirectory.test(path)) return "~";
  if (runCopy.test(path)) return unknownProject;
  const named = scratchFolder.exec(path) ?? treehouseRepository.exec(path);
  const trimmed = path.replace(/\/+$/u, "");
  return named?.[1] ?? (trimmed.slice(trimmed.lastIndexOf("/") + 1) || "/");
};

const resultOf = (result: PueueTaskResult): RunResult => {
  if (result === "Success") return { kind: "success" };
  if (result === "Killed") return { kind: "killed" };
  if (result === "Errored") return { kind: "errored" };
  if (result === "DependencyFailed") return { kind: "dependency" };
  return "Failed" in result ? { kind: "exit", code: result.Failed } : { kind: "spawn", error: result.FailedToSpawn };
};

const namedProjectOf = (path: string, projects: ProjectNames | undefined): string => projects?.get(path) ?? projectOf(path);

const runningRowOf = (projects: ProjectNames | undefined) => (task: PueueTask): ReadonlyArray<RunningRow> =>
  "Running" in task.status
    ? [{ id: task.id, command: task.command, path: task.path, project: namedProjectOf(task.path, projects), startedAt: task.status.Running.start }]
    : [];

const endedRowOf = (projects: ProjectNames | undefined) => (task: PueueTask): ReadonlyArray<EndedRow> => {
  if (!("Done" in task.status)) return [];
  const { start, end, result } = task.status.Done;
  return [
    { id: task.id, command: task.command, path: task.path, project: namedProjectOf(task.path, projects), startedAt: start, endedAt: end, result: resultOf(result) },
  ];
};

const newestEndFirst = (a: EndedRow, b: EndedRow): number =>
  DateTime.toEpochMillis(b.endedAt) - DateTime.toEpochMillis(a.endedAt) || b.id - a.id;

const lowestIdFirst = (a: RunningRow, b: RunningRow): number => a.id - b.id;

export const pueueView = (status: PueueStatus, projects?: ProjectNames): PueueView => {
  const tasks = Object.values(status.tasks);
  return {
    running: tasks.flatMap(runningRowOf(projects)).toSorted(lowestIdFirst),
    ended: tasks.flatMap(endedRowOf(projects)).toSorted(newestEndFirst),
    queued: tasks.filter((task) => "Queued" in task.status).length,
    paused: tasks.filter((task) => "Paused" in task.status).length,
    groups: Object.entries(status.groups).map(([name, group]) => ({ name, status: group.status, parallel: group.parallel_tasks })),
  };
};

export interface MachineQueue {
  readonly name: string;
  readonly pueue: Option.Option<Outcome<PueueView>>;
}

export interface ActionView {
  readonly title: string;
  readonly workflow: string;
  readonly running: boolean;
}

export const newestFirst = (a: ActionRun, b: ActionRun): number => DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt);

const actionViews = (runs: ReadonlyArray<ActionRun>): ReadonlyArray<ActionView> =>
  runs.toSorted(newestFirst).map((run) => ({ title: run.displayTitle, workflow: run.workflowName, running: run.status === "in_progress" }));

export interface ActionsView {
  readonly repo: string;
  readonly runs: Option.Option<Outcome<ReadonlyArray<ActionView>>>;
}

export interface QueuesView {
  readonly machines: ReadonlyArray<MachineQueue>;
  readonly actions: ActionsView;
}

export interface QueueReadings {
  readonly machines: ReadonlyArray<{ readonly name: string; readonly status: Option.Option<Outcome<PueueStatus>> }>;
  readonly actions: { readonly repo: string; readonly runs: Option.Option<Outcome<ReadonlyArray<ActionRun>>> };
}

export interface QueueOutcomes {
  readonly machines: ReadonlyArray<{ readonly name: string; readonly status: Outcome<PueueStatus> }>;
  readonly actions: { readonly repo: string; readonly runs: Outcome<ReadonlyArray<ActionRun>> };
}

export const queuesView = (readings: QueueReadings, projects?: MachineProjects): QueuesView => ({
  machines: readings.machines.map(({ name, status }) => ({ name, pueue: Option.map(status, (read) => mapOutcome(read, (current) => pueueView(current, projects?.get(name)))) })),
  actions: { repo: readings.actions.repo, runs: Option.map(readings.actions.runs, (read) => mapOutcome(read, actionViews)) },
});

export const queuesPending = (view: QueuesView): boolean =>
  view.machines.some((machine) => Option.isNone(machine.pueue)) || Option.isNone(view.actions.runs);
