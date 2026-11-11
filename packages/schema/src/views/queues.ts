import { DateTime, Option } from "effect";
import { mapOutcome, type Outcome } from "../shared/lib";
import type { ActionRun } from "../sources/actions";
import type { TaskEntry } from "../entities/task";
import { taskOwning } from "../entities/task";
import type { HeavyCheck } from "../sources/heavy";
import type { PueueGroupStatus, PueueStatus, PueueTask, PueueTaskResult } from "../sources/pueue";
import { type MachineProjects, type ProjectNames, unknownProject } from "../sources/project-names";

import {
  type EndedJson,
  type PueueJson,
  type QueuesReport,
  type RunningJson,
  type RunJson,
} from "../contract/queues";

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
  readonly heavy: Option.Option<Outcome<HeavyCheck>>;
}

export interface ActionView {
  readonly title: string;
  readonly workflow: string;
  readonly running: boolean;
}

const newestFirst = (a: ActionRun, b: ActionRun): number => DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt);

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
  readonly machines: ReadonlyArray<{
    readonly name: string;
    readonly status: Option.Option<Outcome<PueueStatus>>;
    readonly heavy: Option.Option<Outcome<HeavyCheck>>;
  }>;
  readonly actions: { readonly repo: string; readonly runs: Option.Option<Outcome<ReadonlyArray<ActionRun>>> };
}

export interface QueueOutcomes {
  readonly machines: ReadonlyArray<{ readonly name: string; readonly status: Outcome<PueueStatus> }>;
  readonly actions: { readonly repo: string; readonly runs: Outcome<ReadonlyArray<ActionRun>> };
}

export const queuesView = (readings: QueueReadings, projects?: MachineProjects): QueuesView => ({
  machines: readings.machines.map(({ name, status, heavy }) => ({
    name,
    pueue: Option.map(status, (read) => mapOutcome(read, (current) => pueueView(current, projects?.get(name)))),
    heavy,
  })),
  actions: { repo: readings.actions.repo, runs: Option.map(readings.actions.runs, (read) => mapOutcome(read, actionViews)) },
});

export const queuesPending = (view: QueuesView): boolean =>
  view.machines.some((machine) => Option.isNone(machine.pueue)) || Option.isNone(view.actions.runs);

const runningJson = (row: RunningRow): typeof RunningJson.Type => ({
  id: row.id,
  command: row.command,
  project: row.project,
  startedAt: DateTime.formatIso(row.startedAt),
});

const endedJson = (row: EndedRow): typeof EndedJson.Type => ({
  ...runningJson(row),
  endedAt: DateTime.formatIso(row.endedAt),
  result: row.result,
});

const pueueJson = (projects: ProjectNames | undefined) => (status: PueueStatus): typeof PueueJson.Type => {
  const view = pueueView(status, projects);
  return {
    running: view.running.map(runningJson),
    ended: view.ended.map(endedJson),
    queued: view.queued,
    paused: view.paused,
    groups: view.groups,
  };
};

const runJson = (run: ActionRun): typeof RunJson.Type => ({
  id: run.databaseId,
  title: run.displayTitle,
  workflow: run.workflowName,
  status: run.status,
  createdAt: DateTime.formatIso(run.createdAt),
});

const millis = DateTime.toEpochMillis;

// Pueue dates a run to the millisecond, so a run that starts with its task still belongs to it.
const pueuePrecisionMillis = 1;

export const testsOf = (tasks: ReadonlyArray<TaskEntry>, status: PueueStatus): ReadonlyMap<string, ReadonlyArray<TestRun>> => {
  const view = pueueView(status);
  const runs: ReadonlyArray<TestRun> = [...view.running, ...view.ended];
  const owned = runs.flatMap((run) => {
    const owner = taskOwning(tasks, { folder: run.path, startedAtMillis: millis(run.startedAt) }, pueuePrecisionMillis);
    return owner === undefined ? [] : [{ task: owner.id, run }];
  });
  return new Map(
    [...Map.groupBy(owned, ({ task }) => task)].map(([task, own]) => [
      task,
      own.map(({ run }) => run).toSorted((left, right) => millis(right.startedAt) - millis(left.startedAt)),
    ]),
  );
};

export const queuesReport = ({ machines, actions }: QueueOutcomes, projects?: MachineProjects): QueuesReport => ({
  machines: machines.map(({ name, status }) => ({ name, pueue: mapOutcome(status, pueueJson(projects?.get(name))) })),
  actions: { repo: actions.repo, runs: mapOutcome(actions.runs, (runs) => runs.toSorted(newestFirst).map(runJson)) },
});
