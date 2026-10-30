import { DateTime, Schema } from "effect";
import { mapOutcome } from "../reading";
import { type ActionRun, activeRunStatuses } from "../sources/actions";
import type { MachineProjects, ProjectNames } from "../sources/project-names";
import type { PueueStatus } from "../sources/pueue";
import { type EndedRow, newestFirst, pueueView, type QueueOutcomes, type RunningRow } from "../views/queues";
import { outcomeOf } from "./outcome";

const Count = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const RunningJson = Schema.Struct({ id: Count, command: Schema.String, project: Schema.String, startedAt: Schema.String });

const ResultJson = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["success", "killed", "errored", "dependency"]) }),
  Schema.Struct({ kind: Schema.Literal("exit"), code: Schema.Finite }),
  Schema.Struct({ kind: Schema.Literal("spawn"), error: Schema.String }),
]);

const EndedJson = Schema.Struct({ ...RunningJson.fields, endedAt: Schema.String, result: ResultJson });

const GroupJson = Schema.Struct({ name: Schema.String, status: Schema.Literals(["Running", "Paused", "Reset"]), parallel: Count });

const PueueJson = Schema.Struct({
  running: Schema.Array(RunningJson),
  ended: Schema.Array(EndedJson),
  queued: Count,
  paused: Count,
  groups: Schema.Array(GroupJson),
});

const RunJson = Schema.Struct({
  id: Count,
  title: Schema.String,
  workflow: Schema.String,
  status: Schema.Literals(activeRunStatuses),
  createdAt: Schema.String,
});

export const QueuesReport = Schema.Struct({
  machines: Schema.Array(Schema.Struct({ name: Schema.String, pueue: outcomeOf(PueueJson) })),
  actions: Schema.Struct({ repo: Schema.String, runs: outcomeOf(Schema.Array(RunJson)) }),
});

export type QueuesReport = typeof QueuesReport.Type;

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

export const queuesReport = ({ machines, actions }: QueueOutcomes, projects?: MachineProjects): QueuesReport => ({
  machines: machines.map(({ name, status }) => ({ name, pueue: mapOutcome(status, pueueJson(projects?.get(name))) })),
  actions: { repo: actions.repo, runs: mapOutcome(actions.runs, (runs) => runs.toSorted(newestFirst).map(runJson)) },
});
