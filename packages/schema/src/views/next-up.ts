import { DateTime } from "effect";
import type { ScheduleEntry } from "../contract/tasks";
import type { Failed, Outcome } from "../reading";
import type { RepoFailure } from "../sources/ci-runs";
import type { PueueStatus } from "../sources/pueue";
import type { MachineSchedule, ScheduleRead, ScheduleSource } from "../sources/schedules";
import { nextMatch } from "./calendar";
import { projectOf } from "./queues";

export type NextKind = ScheduleSource | "pueue" | "task";

export interface NextRow {
  readonly kind: NextKind;
  readonly what: string;
  readonly at: DateTime.Utc | undefined;
  readonly everySeconds: number | undefined;
  readonly machine: string | undefined;
}

export type NextSourceState =
  | { readonly kind: "pending" }
  | { readonly kind: "empty" }
  | { readonly kind: "listed" }
  | Failed;

export interface NextSource {
  readonly kind: NextKind;
  readonly state: NextSourceState;
  readonly unread: ReadonlyArray<RepoFailure>;
  readonly machine: string | undefined;
}

export interface NextUp {
  readonly rows: ReadonlyArray<NextRow>;
  readonly sources: ReadonlyArray<NextSource>;
  readonly pending: boolean;
}

export type OrchestratorRead = Outcome<ReadonlyArray<ScheduleEntry>> | "pending" | "absent";

export interface NamedPueue {
  readonly machine: string;
  readonly status: Outcome<PueueStatus> | undefined;
}

export interface NamedOrchestrator {
  readonly machine: string;
  readonly read: OrchestratorRead;
}

// Undefined means the source is still on its first read, and absent means this machine has no such source.
export interface NextReadings {
  readonly schedules: ReadonlyArray<ScheduleRead> | undefined;
  readonly pueues: ReadonlyArray<NamedPueue>;
  readonly orchestrators: ReadonlyArray<NamedOrchestrator>;
  readonly local: string;
  readonly now: DateTime.Utc;
  readonly zone: DateTime.TimeZone;
}

const utc = DateTime.zoneMakeNamedUnsafe("UTC");

const millis = DateTime.toEpochMillis;

const earliest = (instants: ReadonlyArray<DateTime.Utc | undefined>): DateTime.Utc | undefined =>
  instants.reduce<DateTime.Utc | undefined>((first, at) => (at === undefined || (first !== undefined && millis(first) <= millis(at)) ? first : at), undefined);

const repoName = (repo: string): string => repo.slice(repo.lastIndexOf("/") + 1);

interface Timed {
  readonly schedule: MachineSchedule;
  readonly at: DateTime.Utc | undefined;
}

// GitHub reads a workflow's cron in UTC, and launchd reads a calendar interval on the machine's own clock.
const timedOf = (schedule: MachineSchedule, now: DateTime.Utc, zone: DateTime.TimeZone): Timed => {
  switch (schedule.kind) {
    case "timer":
      return { schedule, at: schedule.next };
    case "agent":
      return { schedule, at: earliest(schedule.calendar.map((pattern) => nextMatch(pattern, now, zone))) };
    case "CI":
      return { schedule, at: schedule.pattern === undefined ? undefined : nextMatch(schedule.pattern, now, utc) };
  }
};

const minuteOf = (at: DateTime.Utc | undefined): number | undefined => (at === undefined ? undefined : Math.floor(millis(at) / 60_000));

// The same workflow firing at the same minute in many repositories reads as one row that counts them.
const cronRows = (crons: ReadonlyArray<Timed>): ReadonlyArray<NextRow> => {
  const groups = Map.groupBy(crons, ({ schedule, at }) => `${schedule.name}\u0000${String(minuteOf(at))}`);
  return [...groups.values()].flatMap((group) => {
    const first = group.at(0);
    if (first === undefined || first.schedule.kind !== "CI") return [];
    const repos = [...new Set(group.flatMap(({ schedule }) => (schedule.kind === "CI" ? [schedule.repo] : [])))];
    const what = repos.length === 1 ? `${repoName(repos.at(0) ?? "")} ${first.schedule.name}` : `${first.schedule.name} in ${repos.length} repos`;
    return [{ kind: "CI" as const, what, at: first.at, everySeconds: undefined, machine: undefined }];
  });
};

const machineRows = (timed: ReadonlyArray<Timed>, local: string): ReadonlyArray<NextRow> => [
  ...timed.flatMap(({ schedule, at }): ReadonlyArray<NextRow> => {
    if (schedule.kind === "timer") return at === undefined ? [] : [{ kind: "timer", what: schedule.name, at, everySeconds: undefined, machine: local }];
    if (schedule.kind === "agent") return [{ kind: "agent", what: schedule.name, at, everySeconds: schedule.everySeconds, machine: local }];
    return [];
  }),
  ...cronRows(timed.filter(({ schedule }) => schedule.kind === "CI")),
];

const delayedRows = (status: PueueStatus, machine: string): ReadonlyArray<NextRow> =>
  Object.values(status.tasks).flatMap((task) => {
    if (!("Stashed" in task.status)) return [];
    const at = task.status.Stashed.enqueue_at;
    return at === undefined || at === null ? [] : [{ kind: "pueue" as const, what: `${projectOf(task.path)} ${task.command}`, at, everySeconds: undefined, machine }];
  });

const stateOf = (outcome: Outcome<unknown> | undefined, rows: ReadonlyArray<NextRow>): NextSourceState => {
  if (outcome === undefined) return { kind: "pending" };
  if (outcome.kind !== "ok") return outcome;
  return rows.length === 0 ? { kind: "empty" } : { kind: "listed" };
};

const soonestFirst = (left: NextRow, right: NextRow): number => {
  if (left.at === undefined || right.at === undefined) return Number(left.at === undefined) - Number(right.at === undefined);
  return millis(left.at) - millis(right.at);
};

// Vendor updaters install beside the user's own agents, so only the user's prefixes count.
const ownAgent = (name: string): boolean => name.startsWith("org.nix-community.home.") || name.startsWith("local.");

interface MachineOutcome {
  readonly machine: string;
  readonly outcome: Outcome<unknown> | undefined | "pending";
}

const isFailed = (entry: MachineOutcome): entry is MachineOutcome & { readonly outcome: Failed } =>
  typeof entry.outcome !== "string" && entry.outcome !== undefined && entry.outcome.kind !== "ok";

const machineSources = (kind: "pueue" | "task", entries: ReadonlyArray<MachineOutcome>, rows: ReadonlyArray<NextRow>, machines: number): ReadonlyArray<NextSource> => {
  if (entries.length === 0) return [];
  if (entries.some((entry) => entry.outcome === undefined || entry.outcome === "pending"))
    return [{ kind, state: { kind: "pending" }, unread: [], machine: undefined }];
  const failed = entries.filter(isFailed);
  if (failed.length > 0)
    return failed.map((entry) => ({ kind, state: entry.outcome, unread: [], machine: machines > 1 ? entry.machine : undefined }));
  return [{ kind, state: rows.length === 0 ? { kind: "empty" } : { kind: "listed" }, unread: [], machine: undefined }];
};

export const nextUp = (readings: NextReadings): NextUp => {
  const { now, zone } = readings;
  const machine = (readings.schedules ?? []).map((read) => {
    const owned = read.outcome.kind === "ok" ? read.outcome.value.filter((schedule) => schedule.kind !== "agent" || ownAgent(schedule.name)) : [];
    const timed = owned.map((schedule) => timedOf(schedule, now, zone));
    const rows = machineRows(timed, readings.local).filter((row) => row.at === undefined || millis(row.at) > millis(now));
    return { source: { kind: read.source, state: stateOf(read.outcome, rows), unread: read.unread, machine: undefined }, rows };
  });
  const pueueRows = readings.pueues.flatMap(({ machine: pueueMachine, status }) => (status?.kind === "ok" ? delayedRows(status.value, pueueMachine) : []));
  const present = readings.orchestrators.filter((orchestrator): orchestrator is NamedOrchestrator & { readonly read: Exclude<OrchestratorRead, "absent"> } => orchestrator.read !== "absent");
  const taskRows: ReadonlyArray<NextRow> = present.flatMap(({ machine: taskMachine, read }) =>
    typeof read === "string" || read.kind !== "ok"
      ? []
      : read.value.filter((entry) => millis(entry.at) > millis(now)).map((entry) => ({ kind: "task", what: entry.name, at: entry.at, everySeconds: undefined, machine: taskMachine })),
  );
  return {
    rows: [...machine.flatMap(({ rows }) => rows), ...pueueRows, ...taskRows].toSorted(soonestFirst),
    sources: [
      ...machine.map(({ source }) => source),
      ...machineSources(
        "pueue",
        readings.pueues.map((pueue) => ({ machine: pueue.machine, outcome: pueue.status })),
        pueueRows,
        readings.pueues.length,
      ),
      ...machineSources(
        "task",
        present.map((orchestrator) => ({ machine: orchestrator.machine, outcome: orchestrator.read })),
        taskRows,
        readings.orchestrators.length,
      ),
    ],
    pending: readings.schedules === undefined,
  };
};
