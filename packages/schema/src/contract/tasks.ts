import { DateTime, Option, Schema } from "effect";
import { type Decoded, decoded, decodeJson, flatMapDecoded, rejected } from "../decode";

export const TaskStateJson = Schema.Literals(["working", "waiting", "parked", "blocked", "done"]);

export type TaskState = typeof TaskStateJson.Type;

const TaskJson = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  project: Schema.String,
  kind: Schema.String,
  state: TaskStateJson,
  detail: Schema.String,
  startedAt: Schema.String,
  // A relaunch moves startedAt forward while the live session keeps the earlier start, so the join reads firstStartedAt.
  firstStartedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  folders: Schema.Array(Schema.String),
  branches: Schema.Array(Schema.String),
});

const holdKinds = ["owner", "external", "unstated"] as const;

// Reporters still in use send this kind for a hold on the owner.
const ownerKindAlias = "captain";

const HoldJson = Schema.Struct({ kind: Schema.Literals([...holdKinds, ownerKindAlias]), reason: Schema.String });

export interface Hold {
  readonly kind: (typeof holdKinds)[number];
  readonly reason: string;
}

const holdOf = ({ kind, reason }: typeof HoldJson.Type): Hold => ({ kind: kind === ownerKindAlias ? "owner" : kind, reason });

const PlannedJson = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  project: Schema.String,
  kind: Schema.String,
  home: Schema.String,
  queuedOn: Schema.NullOr(Schema.String),
  hold: Schema.NullOr(HoldJson),
  after: Schema.Array(Schema.String),
});

const OrchestratorJson = Schema.Struct({ name: Schema.String, version: Schema.String });

const OverheadJson = Schema.Struct({ name: Schema.String, folders: Schema.Array(Schema.String) });

export type Orchestrator = typeof OrchestratorJson.Type;

const ScheduleJson = Schema.Struct({ name: Schema.String, at: Schema.String, detail: Schema.String });

export const TasksReport = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  generatedAt: Schema.String,
  orchestrator: OrchestratorJson,
  tasks: Schema.Array(TaskJson),
  projects: Schema.optionalKey(Schema.Array(Schema.String)),
  // Listed in dispatch order, so the first ready entry is the one the orchestrator starts next.
  planned: Schema.optionalKey(Schema.Array(PlannedJson)),
  overhead: Schema.Array(OverheadJson),
  schedules: Schema.Array(ScheduleJson),
});

export type TasksReport = typeof TasksReport.Type;

type TaskEnd =
  | { readonly state: "done"; readonly endedAt: DateTime.Utc }
  | { readonly state: Exclude<TaskState, "done">; readonly endedAt: null };

export type TaskEntry = TaskEnd & {
  readonly id: string;
  readonly title: string;
  readonly project: string;
  readonly kind: string;
  readonly detail: string;
  readonly startedAt: DateTime.Utc;
  readonly firstStartedAt: DateTime.Utc;
  readonly folders: ReadonlyArray<string>;
  readonly branches: ReadonlyArray<string>;
};

export type OverheadEntry = typeof OverheadJson.Type;

export type PlannedEntry = Omit<typeof PlannedJson.Type, "queuedOn" | "hold"> & {
  readonly queuedOn: DateTime.Utc | undefined;
  readonly hold: Hold | undefined;
};

export interface ScheduleEntry {
  readonly name: string;
  readonly at: DateTime.Utc;
  readonly detail: string;
}

export interface TasksView {
  readonly orchestrator: Orchestrator;
  readonly tasks: ReadonlyArray<TaskEntry>;
  readonly planned: ReadonlyArray<PlannedEntry>;
  readonly overhead: ReadonlyArray<OverheadEntry>;
  readonly schedules: ReadonlyArray<ScheduleEntry>;
  readonly registered: ReadonlyArray<string>;
}

export interface ReportedTasks {
  readonly generatedAt: DateTime.Utc;
  readonly view: TasksView;
}

const instantOf =
  (issue: string) =>
  (value: string): Decoded<DateTime.Utc> =>
    Option.match(DateTime.make(value), {
      onNone: () => rejected(issue),
      onSome: (at) => decoded(DateTime.toUtc(at)),
    });

const endOf = ({ id, state, endedAt }: typeof TaskJson.Type): Decoded<TaskEnd> => {
  if (state !== "done") return endedAt === null ? decoded({ state, endedAt }) : rejected(`task ${id} is ${state} but has an endedAt`);
  if (endedAt === null) return rejected(`task ${id} is done but has no endedAt`);
  return flatMapDecoded(instantOf(`task ${id} endedAt is not an instant`)(endedAt), (at) => decoded({ state, endedAt: at }));
};

const taskOf = (task: typeof TaskJson.Type): Decoded<TaskEntry> =>
  flatMapDecoded(instantOf(`task ${task.id} startedAt is not an instant`)(task.startedAt), (startedAt) =>
    flatMapDecoded(
      instantOf(`task ${task.id} firstStartedAt is not an instant`)(task.firstStartedAt),
      (firstStartedAt) =>
        flatMapDecoded(endOf(task), (end) =>
          decoded({
            ...end,
            id: task.id,
            title: task.title,
            project: task.project,
            kind: task.kind,
            detail: task.detail,
            startedAt,
            firstStartedAt,
            folders: task.folders,
            branches: task.branches,
          }),
        ),
    ),
  );

const scheduleOf = (schedule: typeof ScheduleJson.Type): Decoded<ScheduleEntry> =>
  flatMapDecoded(instantOf(`schedule ${schedule.name} at is not an instant`)(schedule.at), (at) =>
    decoded({ name: schedule.name, at, detail: schedule.detail }),
  );

const plannedOf = (planned: typeof PlannedJson.Type): Decoded<PlannedEntry> => {
  const entry = { ...planned, hold: planned.hold === null ? undefined : holdOf(planned.hold) };
  if (planned.queuedOn === null) return decoded({ ...entry, queuedOn: undefined });
  return flatMapDecoded(instantOf(`planned ${planned.id} queuedOn is not an instant`)(planned.queuedOn), (queuedOn) => decoded({ ...entry, queuedOn }));
};

export const reportedTasksOf = (report: TasksReport): Decoded<ReportedTasks> => {
  const generatedAt = instantOf("generatedAt is not an instant")(report.generatedAt);
  if (generatedAt.kind !== "ok") return generatedAt;
  const tasks: Array<TaskEntry> = [];
  for (const task of report.tasks) {
    const entry = taskOf(task);
    if (entry.kind !== "ok") return entry;
    tasks.push(entry.value);
  }
  const schedules: Array<ScheduleEntry> = [];
  for (const schedule of report.schedules) {
    const entry = scheduleOf(schedule);
    if (entry.kind !== "ok") return entry;
    schedules.push(entry.value);
  }
  const planned: Array<PlannedEntry> = [];
  for (const item of report.planned ?? []) {
    const entry = plannedOf(item);
    if (entry.kind !== "ok") return entry;
    planned.push(entry.value);
  }
  return decoded({
    generatedAt: generatedAt.value,
    view: { orchestrator: report.orchestrator, tasks, planned, overhead: report.overhead, schedules, registered: [...new Set(report.projects ?? [])] },
  });
};

const taskJson = (task: TaskEntry): typeof TaskJson.Type => ({
  id: task.id,
  title: task.title,
  project: task.project,
  kind: task.kind,
  state: task.state,
  detail: task.detail,
  startedAt: DateTime.formatIso(task.startedAt),
  firstStartedAt: DateTime.formatIso(task.firstStartedAt),
  endedAt: task.endedAt === null ? null : DateTime.formatIso(task.endedAt),
  folders: task.folders,
  branches: task.branches,
});

export const tasksReport = ({ generatedAt, view }: ReportedTasks): TasksReport => ({
  schemaVersion: 1,
  generatedAt: DateTime.formatIso(generatedAt),
  orchestrator: view.orchestrator,
  tasks: view.tasks.map(taskJson),
  ...(view.planned.length === 0
    ? {}
    : { planned: view.planned.map((item) => ({ ...item, queuedOn: item.queuedOn === undefined ? null : DateTime.formatIso(item.queuedOn), hold: item.hold ?? null })) }),
  overhead: view.overhead,
  schedules: view.schedules.map((schedule) => ({ ...schedule, at: DateTime.formatIso(schedule.at) })),
  ...(view.registered.length === 0 ? {} : { projects: [...view.registered] }),
});

export const decodeTasksReport = (stdout: string): Decoded<ReportedTasks> =>
  flatMapDecoded(decodeJson(TasksReport)(stdout), reportedTasksOf);
