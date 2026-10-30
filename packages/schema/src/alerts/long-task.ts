import { DateTime } from "effect";
import type { LongTaskEvent, LongTaskSettings } from "../contract/alerts";
import type { ReportedTasks, TaskEntry } from "../contract/tasks";
import type { Outcome } from "../reading";
import type { Stepped } from "./episode";

export interface MachineTasks {
  readonly name: string;
  readonly reading: Outcome<ReportedTasks>;
}

interface Watch {
  readonly machine: string;
  readonly milestone: string;
  readonly quietSince: number;
  readonly quietEvents: number;
  readonly passedTotal: boolean;
}

export type LongTaskState = ReadonlyMap<string, Watch>;

export const longTaskStart: LongTaskState = new Map();

const minuteMillis = 60_000;

const minutesOf = (millis: number): number => Math.round(millis / (minuteMillis / 10)) / 10;

// The tasks report dates no milestone, so a change in a task's state or detail between two samples is its new milestone.
const milestoneOf = (task: TaskEntry): string => `${task.state}\n${task.detail}`;

const quietEventsDue = (quietMillis: number, settings: LongTaskSettings): number => {
  const first = settings.quietMinutes * minuteMillis;
  return quietMillis < first ? 0 : 1 + Math.floor((quietMillis - first) / (settings.repeatMinutes * minuteMillis));
};

const eventOf = (reason: LongTaskEvent["reason"], machine: string, task: TaskEntry, watch: Watch, now: number): LongTaskEvent => ({
  schemaVersion: 1,
  rule: "long-task",
  reason,
  at: DateTime.formatIso(DateTime.makeUnsafe(now)),
  machine,
  task: {
    id: task.id,
    title: task.title,
    project: task.project,
    state: task.state,
    detail: task.detail,
    firstStartedAt: DateTime.formatIso(task.firstStartedAt),
  },
  quietSince: DateTime.formatIso(DateTime.makeUnsafe(watch.quietSince)),
  quietMinutes: minutesOf(now - watch.quietSince),
  totalMinutes: minutesOf(now - DateTime.toEpochMillis(task.firstStartedAt)),
});

const watched = (previous: Watch | undefined, machine: string, task: TaskEntry, now: number): Watch => {
  const milestone = milestoneOf(task);
  if (previous !== undefined && previous.milestone === milestone) return previous;
  return { machine, milestone, quietSince: now, quietEvents: 0, passedTotal: previous?.passedTotal ?? false };
};

interface TaskStep {
  readonly watch: Watch | undefined;
  readonly events: ReadonlyArray<LongTaskEvent>;
}

// A task resting in a state the rule skips keeps whether it passed its total, so coming back raises no second total event.
const taskStep = (previous: Watch | undefined, machine: string, task: TaskEntry, now: number, settings: LongTaskSettings): TaskStep => {
  if (!settings.states.includes(task.state)) return { watch: previous && { ...previous, milestone: milestoneOf(task) }, events: [] };
  const watch = watched(previous, machine, task, now);
  const due = quietEventsDue(now - watch.quietSince, settings);
  const quiet = due > watch.quietEvents;
  const total = !watch.passedTotal && now - DateTime.toEpochMillis(task.firstStartedAt) >= settings.totalHours * 60 * minuteMillis;
  return {
    watch: { ...watch, quietEvents: Math.max(due, watch.quietEvents), passedTotal: watch.passedTotal || total },
    events: [...(quiet ? [eventOf("quiet", machine, task, watch, now)] : []), ...(total ? [eventOf("total", machine, task, watch, now)] : [])],
  };
};

// A task first seen starts its quiet time at that sample, since the report cannot say when its detail last changed.
// A machine the sample leaves out or could not read keeps its watches, so a dropped read restarts no clock.
export const longTaskStep = (
  state: LongTaskState,
  sample: Outcome<ReadonlyArray<MachineTasks>>,
  now: DateTime.Utc,
  settings: LongTaskSettings,
): Stepped<LongTaskState, LongTaskEvent> => {
  if (sample.kind !== "ok") return { state, events: [] };
  const at = DateTime.toEpochMillis(now);
  const read = new Set(sample.value.flatMap(({ name, reading }) => (reading.kind === "ok" ? [name] : [])));
  const next = new Map([...state].filter(([, watch]) => !read.has(watch.machine)));
  const events: Array<LongTaskEvent> = [];
  for (const { name, reading } of sample.value) {
    if (reading.kind !== "ok") continue;
    for (const task of reading.value.view.tasks) {
      const key = `${name}\n${task.id}`;
      const step = taskStep(state.get(key), name, task, at, settings);
      if (step.watch !== undefined) next.set(key, step.watch);
      events.push(...step.events);
    }
  }
  return { state: next, events };
};
