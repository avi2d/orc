import { DateTime } from "effect";
import type { TaskState } from "../contract/tasks";
import type { LimitEpisode } from "./task-history";
import type { PlannedRow } from "./planned";
import type { TestRun } from "./queues";
import type { TaskPipeline } from "./task-pipeline";
import type { TaskSpend } from "./task-spend";

export type ShownState = TaskState | "unknown";

export interface TaskProcessRow {
  readonly pid: number;
  readonly identity: string;
  readonly parent: string | undefined;
  readonly program: string | undefined;
  readonly ownSeconds: number;
  readonly waitedChildSeconds: number;
  readonly residentBytes: number;
  readonly resting: boolean;
}

export interface LiveUsage {
  readonly cpuCores: number;
  readonly residentBytes: number;
  readonly processes: ReadonlyArray<TaskProcessRow>;
}

export interface TaskRow {
  readonly id: string;
  readonly machine: string;
  readonly source: "local" | "remote";
  readonly listed: boolean;
  readonly usageRead: boolean;
  readonly title: string;
  readonly project: string;
  readonly state: ShownState;
  readonly detail: string | undefined;
  readonly firstStartedAt: DateTime.Utc;
  readonly endedAt: DateTime.Utc | undefined;
  readonly seconds: number;
  readonly cpuSeconds: number | undefined;
  readonly peakBytes: number | undefined;
  readonly live: LiveUsage | undefined;
  readonly idled: boolean;
  readonly tests: ReadonlyArray<TestRun>;
  readonly testSeconds: number | undefined;
  readonly episodes: ReadonlyArray<LimitEpisode>;
  readonly spend: TaskSpend | undefined;
  readonly kind: string | undefined;
  readonly pipeline: TaskPipeline | undefined;
  readonly lastActiveAt: DateTime.Utc | undefined;
}

export interface ProjectRow {
  readonly name: string;
  readonly tasks: ReadonlyArray<TaskRow>;
  readonly planned: ReadonlyArray<PlannedRow>;
  readonly working: number;
  readonly waiting: number;
  readonly parked: number;
  readonly blocked: number;
  readonly done: number;
  readonly ready: number;
  readonly held: number;
  readonly seconds: number | undefined;
  readonly cpuSeconds: number | undefined;
  readonly residentBytes: number | undefined;
  readonly episodes: ReadonlyArray<LimitEpisode>;
}

const millis = DateTime.toEpochMillis;

const liveStates: ReadonlySet<ShownState> = new Set(["working", "waiting", "parked", "blocked"]);

export const isLive = (state: ShownState): boolean => liveStates.has(state);

export const runsWork = (live: LiveUsage | undefined): boolean => live?.processes.some((process) => !process.resting) ?? false;

export const sumOf = (values: ReadonlyArray<number | undefined>): number | undefined => {
  const known = values.filter((value) => value !== undefined);
  return known.length === 0 ? undefined : known.reduce((total, value) => total + value, 0);
};

const byId = (left: TaskRow, right: TaskRow): number => left.id.localeCompare(right.id) || left.machine.localeCompare(right.machine);

const endedMillisOf = (task: TaskRow): number => (task.endedAt === undefined ? Number.NEGATIVE_INFINITY : millis(task.endedAt));

const newestEndedFirst = (left: TaskRow, right: TaskRow): number => endedMillisOf(right) - endedMillisOf(left) || byId(left, right);

export const doneNewestFirst = (left: TaskRow, right: TaskRow): number => {
  if (left.state === "done" && right.state === "done") return newestEndedFirst(left, right);
  if (left.state === "done") return -1;
  if (right.state === "done") return 1;
  return byId(left, right);
};

// Entries with no project arrive named "?".
export const projectNameOf = (name: string): string => (name === "?" ? "no project" : name);

export const projectOf = (name: string, tasks: ReadonlyArray<TaskRow>, planned: ReadonlyArray<PlannedRow>): ProjectRow => {
  const live = tasks.filter((task) => isLive(task.state));
  const countOf = (state: TaskState): number => tasks.filter((task) => task.state === state).length;
  const ready = planned.filter((row) => row.next !== undefined).length;
  return {
    name,
    tasks: [...live.toSorted(byId), ...tasks.filter((task) => !isLive(task.state)).toSorted(doneNewestFirst)],
    planned,
    working: countOf("working"),
    waiting: countOf("waiting"),
    parked: countOf("parked"),
    blocked: countOf("blocked"),
    done: countOf("done"),
    ready,
    held: planned.length - ready,
    seconds: live.length === 0 ? undefined : Math.max(...live.map((task) => task.seconds)),
    cpuSeconds: sumOf(tasks.map((task) => task.cpuSeconds)),
    residentBytes: sumOf(tasks.map((task) => task.live?.residentBytes)),
    episodes: tasks.flatMap((task) => task.episodes),
  };
};
