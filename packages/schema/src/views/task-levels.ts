import { DateTime } from "effect";
import type { TaskSampleRecord } from "../contract/task-samples";
import type { ReportedTasks, TaskEntry } from "../contract/tasks";
import { plannedRowsOf, type PlannedRow } from "./planned";
import { byProject } from "./project-order";
import type { NoMistakesSnapshot } from "../contract/no-mistakes";
import type { OrcSnapshot } from "../contract/orc";
import type { Failed, Outcome } from "../reading";
import type { PueueStatus } from "../sources/pueue";
import type { ProcessSamples } from "../sources/task-processes";
import { cueStageSecondsOf, orcStageSecondsOf } from "./stage-time";
import { pueueView, type RunOwners, type TestRun } from "./queues";
import { orcPipelineOf } from "./orc-pipeline";
import {
  anchorOf,
  cuePipelineOf,
  donePipelineOf,
  fullReviewPipelineOf,
  kindOf,
  noMistakesRunOf,
  type OpenTaskState,
  orcRunOf,
  type StageMark,
  type TaskPipeline,
  withAnchorSeconds,
  withDetailCue,
} from "./task-pipeline";
import { type KeptProcess, keptCpuSeconds, type LimitEpisode, type TaskHistory, taskHistories } from "./task-history";
import type { SessionQuotaView } from "./session-quota";
import { treeRestsOf } from "./task-pane-assessment";
import { ownedProcesses, taskOwning, totalSecondsOf, within } from "./task-resources";
import { type TaskSpend, taskSpend } from "./task-spend";
import { isLive, projectOf, sumOf, type LiveUsage, type ProjectRow, type ShownState, type TaskRow } from "./task-projects";

export { doneNewestFirst, isLive, projectNameOf, projectOf, runsWork, type LiveUsage, type ProjectRow, type ShownState, type TaskProcessRow, type TaskRow } from "./task-projects";

export interface LiveTasks {
  readonly samples: ProcessSamples;
  readonly programs: ReadonlyMap<number, string>;
  readonly memoryBytes: number;
}

export type TaskListing = Outcome<ReportedTasks> | { readonly kind: "pending" } | { readonly kind: "unset" };

export interface TaskLevelReadings {
  readonly machine: string;
  // Local levels read this machine's report, and remote levels read the other machine's.
  readonly origin: "local" | "remote";
  readonly tasks: TaskListing;
  readonly samples: ReadonlyArray<TaskSampleRecord>;
  readonly live: Outcome<LiveTasks> | undefined;
  readonly liveConfigured: boolean;
  readonly pueue: Outcome<PueueStatus> | undefined;
  readonly noMistakes: Outcome<NoMistakesSnapshot> | undefined;
  readonly orc: Outcome<OrcSnapshot> | undefined;
  readonly sessions: SessionQuotaView | undefined;
  readonly now: DateTime.Utc;
  readonly days: number;
  readonly zone: DateTime.TimeZone;
  readonly interval?: Interval | undefined;
}

type LevelSource = "tasks" | "processes" | "pueue" | "no-mistakes" | "orc";

export interface SourceFailure {
  readonly source: LevelSource;
  readonly failure: Failed;
}

export type Interval = "today" | "all";

export interface TaskLevels {
  readonly machine: string;
  // Every machine whose report the board reads, whether or not it has a task in the window.
  readonly machines: ReadonlyArray<string>;
  readonly interval: Interval;
  readonly source: "local" | "remote";
  readonly days: number;
  readonly registered: ReadonlyArray<string>;
  readonly now: DateTime.Utc;
  readonly pending: boolean;
  readonly unset: boolean;
  readonly listed: boolean;
  readonly usageRead: boolean;
  readonly liveConfigured: boolean;
  readonly failures: ReadonlyArray<SourceFailure>;
  readonly projects: ReadonlyArray<ProjectRow>;
  readonly runOwners: RunOwners;
}

const millis = DateTime.toEpochMillis;

export const secondsFrom = (from: DateTime.Utc, to: DateTime.Utc): number => Math.max(0, (millis(to) - millis(from)) / 1000);

const testSecondsOf = (run: TestRun, now: DateTime.Utc): number => secondsFrom(run.startedAt, "endedAt" in run ? run.endedAt : now);

interface Joined {
  readonly live: ReadonlyMap<string, LiveUsage>;
  readonly treeRests: (folder: string) => boolean;
  readonly memoryBytes: number | undefined;
  readonly tests: ReadonlyMap<string, ReadonlyArray<TestRun>>;
  readonly spend: ReadonlyMap<string, TaskSpend>;
  readonly noMistakes: NoMistakesSnapshot | undefined;
  readonly orc: OrcSnapshot | undefined;
}

const liveUsageOf = (tasks: ReadonlyArray<TaskEntry>, live: LiveTasks, treeRests: (folder: string) => boolean): ReadonlyMap<string, LiveUsage> => {
  const foldersOf = new Map(tasks.map((task) => [task.id, task.folders]));
  const usage = new Map<string, LiveUsage>();
  for (const [task, owned] of Map.groupBy(ownedProcesses(tasks, live.samples), (process) => process.task)) {
    const processes = owned
      .map(({ pid, identity, parent, ownSeconds, waitedChildSeconds, residentBytes, folder }) => {
        const containing = (foldersOf.get(task) ?? []).filter((name) => within(folder, name));
        return {
          pid,
          identity,
          parent,
          program: live.programs.get(pid),
          ownSeconds,
          waitedChildSeconds,
          residentBytes,
          resting: containing.length > 0 && containing.every(treeRests),
        };
      })
      .toSorted((left, right) => totalSecondsOf(right) - totalSecondsOf(left) || right.residentBytes - left.residentBytes);
    usage.set(task, {
      cpuCores: owned.reduce((total, process) => total + process.cpuCores, 0),
      residentBytes: owned.reduce((total, process) => total + process.residentBytes, 0),
      processes,
    });
  }
  return usage;
};

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

const okValue = <A>(outcome: Outcome<A> | { readonly kind: "pending" | "unset" } | undefined): A | undefined =>
  outcome?.kind === "ok" ? outcome.value : undefined;

const joinedOf = (tasks: ReadonlyArray<TaskEntry>, readings: TaskLevelReadings): Joined => {
  const live = okValue(readings.live);
  const pueue = okValue(readings.pueue);
  const view = readings.sessions;
  const onMachine = (entry: { readonly machine?: string }) =>
    entry.machine === undefined ? readings.origin === "local" : entry.machine === readings.machine;
  const trees = treeRestsOf(view, readings.machine, readings.origin);
  return {
    live: live === undefined ? new Map() : liveUsageOf(tasks, live, trees),
    treeRests: trees,
    memoryBytes: live?.memoryBytes,
    tests: pueue === undefined ? new Map() : testsOf(tasks, pueue),
    spend: readings.sessions === undefined ? new Map() : taskSpend(readings.sessions, tasks, onMachine),
    noMistakes: okValue(readings.noMistakes),
    orc: okValue(readings.orc),
  };
};

const withLiveMemory = (episodes: ReadonlyArray<LimitEpisode>, live: LiveUsage | undefined, memoryBytes: number | undefined, now: DateTime.Utc) => {
  const overNow = live !== undefined && memoryBytes !== undefined && live.residentBytes > memoryBytes / 4;
  if (!overNow || episodes.some((episode) => episode.limit === "memory" && episode.ongoing)) return episodes;
  return [...episodes.filter((episode) => episode.limit !== "memory"), { limit: "memory" as const, from: now, to: now, ongoing: true }];
};

interface Described {
  readonly id: string;
  readonly title: string;
  readonly project: string;
  readonly folders: ReadonlyArray<string>;
  readonly state: ShownState;
  readonly detail: string | undefined;
  readonly firstStartedAt: DateTime.Utc;
  readonly endedAt: DateTime.Utc | undefined;
  readonly tests: ReadonlyArray<TestRun>;
  readonly spend: TaskSpend | undefined;
  readonly kind: string | undefined;
  readonly branches: ReadonlyArray<string>;
}

// A done task reports no folders and collapsed times, so its join finds no spend; the samples it left behind still name its model and span.
const reportedOf = (task: TaskEntry, joined: Joined, history: TaskHistory | undefined): Described => ({
  id: task.id,
  title: task.title,
  project: task.project,
  folders: task.folders,
  state: task.state,
  detail: task.detail,
  firstStartedAt: task.state === "done" && history !== undefined && millis(history.task.firstStartedAt) < millis(task.firstStartedAt) ? history.task.firstStartedAt : task.firstStartedAt,
  endedAt: task.endedAt ?? undefined,
  tests: joined.tests.get(task.id) ?? [],
  spend: joined.spend.get(task.id) ?? (task.state === "done" ? history?.spend : undefined),
  kind: task.kind,
  branches: task.branches,
});

const sampledEnd = (history: TaskHistory, listed: boolean): Pick<Described, "state" | "endedAt"> => {
  const { task } = history;
  if (task.endedAt !== null) return { state: "done", endedAt: task.endedAt };
  // A task the orchestrator no longer lists left no word on how it ended, so its time stops at its last sample.
  if (listed) return { state: "unknown", endedAt: history.lastSampledAt };
  return { state: task.state, endedAt: undefined };
};

const sampledOf = (history: TaskHistory, listed: boolean): Described => ({
  id: history.task.id,
  title: history.task.title,
  project: history.task.project,
  folders: [],
  detail: undefined,
  firstStartedAt: history.task.firstStartedAt,
  tests: history.tests,
  spend: history.spend,
  kind: undefined,
  branches: [],
  ...sampledEnd(history, listed),
});

const pipelineFor = (described: Described, joined: Joined, history: TaskHistory | undefined, now: DateTime.Utc): TaskPipeline | undefined => {
  const kind = kindOf(described.kind ?? "");
  if (kind === undefined) return undefined;
  if (described.state === "done") return donePipelineOf(kind);
  const detail = described.detail ?? "";
  if (kind === "full review fix") return withDetailCue(fullReviewPipelineOf(noMistakesRunOf(joined.noMistakes, described.branches), described.state), detail);
  if (kind === "orc run") {
    const pipeline = orcPipelineOf(orcRunOf(joined.orc, described.id, described.branches), described.state);
    return withAnchorSeconds(withDetailCue(pipeline, detail), orcStageSecondsOf(anchorOf(pipeline.stages)?.name, history?.cues ?? [], now));
  }
  const cue = { kind, state: described.state, detail, branches: described.branches };
  return withAnchorSeconds(cuePipelineOf(kind, cue.state, detail, cue.branches), cueStageSecondsOf(cue, history?.cues ?? [], now));
};

const heldStates: ReadonlyArray<readonly [StageMark, OpenTaskState]> = [
  ["failed", "blocked"],
  ["needsYou", "waiting"],
  ["waiting", "parked"],
];

const stateRank: ReadonlyArray<ShownState> = ["working", "parked", "waiting", "blocked"];

// A recorded stage can hold a task the orchestrator still calls working, and never eases a state it reports.
export interface GateHold {
  readonly mark: Extract<StageMark, "needsYou" | "waiting">;
  readonly seconds: number | undefined;
}

// Only the recorded full review row names a gate, so only it holds the pane; cue rows read their wait from the worker detail.
export const gateHoldOf = (pipeline: TaskPipeline | undefined): GateHold | undefined => {
  if (pipeline?.kind !== "full review fix") return undefined;
  const anchor = anchorOf(pipeline.stages);
  if (anchor?.mark !== "needsYou" && anchor?.mark !== "waiting") return undefined;
  return { mark: anchor.mark, seconds: pipeline.parkedSeconds };
};

const stateHeldBy = (state: ShownState, pipeline: TaskPipeline | undefined): ShownState => {
  if (!isLive(state)) return state;
  const held = heldStates.find(([mark]) => pipeline?.stages.some((stage) => stage.mark === mark) === true)?.[1];
  return held !== undefined && stateRank.indexOf(held) > stateRank.indexOf(state) ? held : state;
};

const rowOf = (described: Described, history: TaskHistory | undefined, joined: Joined, origin: Pick<TaskRow, "machine" | "source" | "listed" | "usageRead">, now: DateTime.Utc): TaskRow => {
  const live = joined.live.get(described.id);
  const pipeline = pipelineFor(described, joined, history, now);
  const held = stateHeldBy(described.state, pipeline);
  const idle = held === "working" && described.folders.length > 0 && described.folders.every(joined.treeRests);
  const kept = new Map<string, KeptProcess>(history?.processes);
  for (const { identity, parent, ownSeconds, waitedChildSeconds } of live?.processes ?? [])
    kept.set(identity, { parent, ownSeconds, waitedChildSeconds, sampledAtMillis: millis(now) });
  const peaks = [history?.peakBytes, live?.residentBytes].filter((value) => value !== undefined);
  return {
    ...described,
    ...origin,
    state: idle ? "parked" : held,
    idled: idle,
    pipeline,
    lastActiveAt: history?.lastActiveAt,
    seconds: secondsFrom(described.firstStartedAt, described.endedAt ?? now),
    cpuSeconds: kept.size === 0 ? undefined : keptCpuSeconds(kept),
    peakBytes: peaks.length === 0 ? undefined : Math.max(...peaks),
    live,
    testSeconds: sumOf(described.tests.map((run) => testSecondsOf(run, now))),
    episodes: withLiveMemory(history?.episodes ?? [], live, joined.memoryBytes, now),
  };
};

const failuresOf = (readings: TaskLevelReadings): ReadonlyArray<SourceFailure> =>
  (
    [
      ["tasks", readings.tasks],
      ["processes", readings.live],
      ["pueue", readings.pueue],
      ["no-mistakes", readings.noMistakes],
      ["orc", readings.orc],
    ] as const
  ).flatMap(([source, outcome]) =>
    outcome?.kind === "unreachable" || outcome?.kind === "invalid" ? [{ source, failure: outcome }] : [],
  );

const startOfTodayMillis = (now: DateTime.Utc, zone: DateTime.TimeZone): number => millis(DateTime.startOf(DateTime.setZone(now, zone), "day"));

const endedToday = (row: TaskRow, startOfToday: number): boolean =>
  row.state !== "done" || (row.endedAt !== undefined && millis(row.endedAt) >= startOfToday);

const projectsOf = (
  rows: ReadonlyArray<TaskRow>,
  planned: ReadonlyArray<PlannedRow>,
  registered: ReadonlyArray<string>,
): ReadonlyArray<ProjectRow> => {
  const plannedBy = Map.groupBy(planned, (row) => row.project);
  const names = new Set([...rows.map((row) => row.project), ...plannedBy.keys(), ...registered]);
  return [...names]
    .map((name) => projectOf(name, rows.filter((row) => row.project === name), plannedBy.get(name) ?? []))
    .toSorted(byProject);
};

export const taskLevels = (readings: TaskLevelReadings): TaskLevels => {
  const { now, interval = "today" } = readings;
  const startOfToday = startOfTodayMillis(now, readings.zone);
  const reported = okValue(readings.tasks)?.view.tasks ?? [];
  const histories = taskHistories(readings.samples, now, readings.days);
  const joined = joinedOf(reported, readings);
  const listed = readings.tasks.kind === "ok";
  const reportedIds = new Set(reported.map((task) => task.id));
  const origin = { machine: readings.machine, source: readings.origin, listed, usageRead: readings.live?.kind === "ok" };
  const every = [
    ...reported.map((task) => rowOf(reportedOf(task, joined, histories.get(task.id)), histories.get(task.id), joined, origin, now)),
    ...[...histories.values()].filter((history) => !reportedIds.has(history.task.id)).map((history) => rowOf(sampledOf(history, listed), history, joined, origin, now)),
  ];
  const rows = interval === "today" ? every.filter((row) => endedToday(row, startOfToday)) : every;
  const view = okValue(readings.tasks)?.view;
  const projects = projectsOf(rows, plannedRowsOf(view?.planned ?? [], readings.machine), view?.registered ?? []);
  return {
    machine: readings.machine,
    machines: [readings.machine],
    interval,
    source: readings.origin,
    days: readings.days,
    registered: view?.registered ?? [],
    now,
    pending: readings.tasks.kind === "pending",
    unset: readings.tasks.kind === "unset",
    listed,
    usageRead: readings.live?.kind === "ok",
    liveConfigured: readings.liveConfigured,
    failures: failuresOf(readings),
    projects,
    runOwners: new Map(every.flatMap((row) => row.tests.map((run) => [run.id, row.id] as const))),
  };
};

// The switch between today and all is a view over the same read, so the dashboard toggles it without re-reading.
// Today keeps done tasks whose end is after local midnight; all keeps everything the samples hold.
export const atInterval = (levels: TaskLevels, interval: Interval, now: DateTime.Utc, zone: DateTime.TimeZone): TaskLevels => {
  if (interval === levels.interval) return levels;
  if (interval === "all") return { ...levels, interval };
  const startOfToday = startOfTodayMillis(now, zone);
  const rows = levels.projects.flatMap((project) => project.tasks).filter((row) => endedToday(row, startOfToday));
  const projects = projectsOf(
    rows,
    levels.projects.flatMap((project) => project.planned),
    levels.registered,
  );
  return { ...levels, interval, projects };
};
