import { DateTime, Duration } from "effect";
import type { CiRun } from "../sources/ci-runs";
import type { EndedRow, PueueView, RunOwners, RunningRow } from "./queues";
import { secondsFrom } from "./task-levels";

export type QueueRowState = "running" | "waiting" | "success" | "failure" | "cancelled" | "skipped";

export interface QueueRow {
  readonly kind: "CI" | "pueue";
  // A CI run is read once for every machine, so it names none.
  readonly machine: string | undefined;
  // The repository of a CI run, or the task or folder of a pueue run.
  readonly where: string;
  readonly what: string;
  readonly state: QueueRowState;
  readonly endedAt: DateTime.Utc | undefined;
  readonly tookSeconds: number | undefined;
}

export interface MachineQueueView {
  readonly running: number;
  readonly waiting: number;
  readonly queuedInPueue: number;
  readonly rows: ReadonlyArray<QueueRow>;
}

const millis = DateTime.toEpochMillis;

const repoName = (repo: string): string => repo.slice(repo.lastIndexOf("/") + 1);

// GitHub concludes a run with one of these words, and every one not listed here, such as failure or timed_out, is a failure.
const concluded = (conclusion: string | undefined): QueueRowState => {
  if (conclusion === "success" || conclusion === "neutral") return "success";
  if (conclusion === "cancelled") return "cancelled";
  return conclusion === "skipped" ? "skipped" : "failure";
};

// A run's own times include the wait for a runner and GitHub's bookkeeping after it, so how long it took comes from its jobs.
const ciRow = (run: CiRun, now: DateTime.Utc): QueueRow => {
  const where = repoName(run.repo);
  const what = run.workflow;
  if (run.status === "waiting") return { kind: "CI", machine: undefined, where, what, state: "waiting", endedAt: undefined, tookSeconds: undefined };
  if (run.status === "running")
    return { kind: "CI", machine: undefined, where, what, state: "running", endedAt: undefined, tookSeconds: secondsFrom(run.jobs?.startedAt ?? run.createdAt, now) };
  const span = run.jobs;
  return {
    kind: "CI",
    machine: undefined,
    where,
    what,
    state: concluded(run.conclusion),
    endedAt: span?.endedAt ?? run.updatedAt,
    tookSeconds: span === undefined ? undefined : secondsFrom(span.startedAt, span.endedAt ?? run.updatedAt),
  };
};

// A task's name says more than its folder, which for a pipeline run is a bare run id.
const pueueWhere = (run: RunningRow, owners: RunOwners): string => owners.get(run.id) ?? run.project;

const runningRow = (run: RunningRow, owners: RunOwners, machine: string | undefined, now: DateTime.Utc): QueueRow => ({
  kind: "pueue",
  machine,
  where: pueueWhere(run, owners),
  what: run.command,
  state: "running",
  endedAt: undefined,
  tookSeconds: secondsFrom(run.startedAt, now),
});

const endedState = (run: EndedRow): QueueRowState => {
  if (run.result.kind === "success") return "success";
  return run.result.kind === "killed" ? "cancelled" : "failure";
};

const endedRow = (run: EndedRow, owners: RunOwners, machine: string | undefined): QueueRow => ({
  kind: "pueue",
  machine,
  where: pueueWhere(run, owners),
  what: run.command,
  state: endedState(run),
  endedAt: run.endedAt,
  tookSeconds: secondsFrom(run.startedAt, run.endedAt),
});

export const queueWindow = Duration.days(1);

const order: Readonly<Record<"running" | "waiting" | "ended", number>> = { running: 0, waiting: 1, ended: 2 };

const placeOf = (row: QueueRow): number => (row.state === "running" || row.state === "waiting" ? order[row.state] : order.ended);

const byPlace = (left: QueueRow, right: QueueRow): number =>
  placeOf(left) - placeOf(right) || millis(right.endedAt ?? DateTime.makeUnsafe(0)) - millis(left.endedAt ?? DateTime.makeUnsafe(0));

export interface QueueEntry {
  readonly machine: string;
  readonly pueue: PueueView | undefined;
  readonly owners: RunOwners;
}

// The queue lists what runs and waits now and what ended in the last day, so a week of pueue history does not bury today's runs.
export const machineQueue = (entries: ReadonlyArray<QueueEntry>, ci: ReadonlyArray<CiRun>, now: DateTime.Utc): MachineQueueView => {
  const since = millis(now) - Duration.toMillis(queueWindow);
  const rows = [
    ...entries.flatMap(({ machine, pueue, owners }) => [
      ...(pueue?.running ?? []).map((run) => runningRow(run, owners, machine, now)),
      ...(pueue?.ended ?? []).filter((run) => millis(run.endedAt) >= since).map((run) => endedRow(run, owners, machine)),
    ]),
    ...ci.map((run) => ciRow(run, now)).filter((row) => row.endedAt === undefined || millis(row.endedAt) >= since),
  ].toSorted(byPlace);
  return {
    running: rows.filter((row) => row.state === "running").length,
    waiting: rows.filter((row) => row.state === "waiting").length,
    queuedInPueue: entries.reduce((total, entry) => total + (entry.pueue?.queued ?? 0), 0),
    rows,
  };
};
