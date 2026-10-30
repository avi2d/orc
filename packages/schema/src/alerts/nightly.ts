import { DateTime } from "effect";
import type { NightlyEvent, NightlySettings } from "../contract/alerts";
import type { CiReport, CiRun } from "../sources/ci-runs";
import type { Outcome } from "../reading";
import type { CronSchedule, ScheduleRead } from "../sources/schedules";
import { type CalendarPattern, nextMatch } from "../views/calendar";
import type { Stepped } from "./episode";

export interface NightlyInputs {
  readonly schedules: ReadonlyArray<ScheduleRead>;
  readonly report: CiReport;
}

export type NightlySample = Outcome<NightlyInputs>;

export type NightlyState = ReadonlyMap<string, number>;

export const nightlyStart: NightlyState = new Map();

// The night-run workflow keeps 02:00 to 05:00 UTC, so a schedule counts when every hour it fires sits inside those hours.
const nightHours: ReadonlySet<number> = new Set([2, 3, 4]);

const isNightPattern = (pattern: CalendarPattern): boolean => pattern.hours.size > 0 && [...pattern.hours].every((hour) => nightHours.has(hour));

interface NightWorkflow {
  readonly repo: string;
  readonly workflow: string;
  readonly patterns: ReadonlyArray<CalendarPattern>;
  readonly home: string;
}

const keyOf = (repo: string, workflow: string): string => `${repo}\n${workflow}`;

const cronsOf = (schedules: ReadonlyArray<ScheduleRead>): ReadonlyArray<CronSchedule> =>
  schedules.flatMap((read) =>
    read.source === "CI" && read.outcome.kind === "ok"
      ? read.outcome.value.flatMap((schedule): ReadonlyArray<CronSchedule> => (schedule.kind === "CI" ? [schedule] : []))
      : [],
  );

const nightWorkflowsOf = (schedules: ReadonlyArray<ScheduleRead>, settings: NightlySettings): ReadonlyArray<NightWorkflow> => {
  const unread = new Set(schedules.flatMap((read) => read.unread.map((failure) => failure.repo)));
  const grouped = Map.groupBy(
    cronsOf(schedules).filter((schedule) => schedule.pattern !== undefined && isNightPattern(schedule.pattern) && !unread.has(schedule.repo)),
    (schedule) => keyOf(schedule.repo, schedule.name),
  );
  return [...grouped.values()].flatMap((group) => {
    const first = group[0];
    if (!Object.hasOwn(settings.homes, first.repo)) return [];
    const home = settings.homes[first.repo];
    return [
      {
        repo: first.repo,
        workflow: first.name,
        patterns: group.flatMap((schedule) => (schedule.pattern === undefined ? [] : [schedule.pattern])),
        home,
      },
    ];
  });
};

const newestFirst = (left: CiRun, right: CiRun): number =>
  DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt) || right.id - left.id;

const clearsRun = (conclusion: string | undefined): boolean => conclusion === "success" || conclusion === "neutral";

const failsRun = (conclusion: string | undefined): conclusion is string =>
  conclusion !== undefined && conclusion !== "success" && conclusion !== "neutral" && conclusion !== "cancelled" && conclusion !== "skipped";

interface Decision {
  readonly run: CiRun;
  readonly conclusion: string;
  readonly failed: boolean;
}

// A cancelled or skipped rerun says nothing of the red underneath, so the search looks past it to the older run.
const decisionOf = (runs: ReadonlyArray<CiRun>): Decision | undefined => {
  const decided = runs
    .filter((run) => run.status === "done")
    .toSorted(newestFirst)
    .find((run) => failsRun(run.conclusion) || clearsRun(run.conclusion));
  if (decided === undefined || decided.conclusion === undefined) return undefined;
  return { run: decided, conclusion: decided.conclusion, failed: failsRun(decided.conclusion) };
};

const utc = DateTime.zoneMakeNamedUnsafe("UTC");

const recheckOf = (patterns: ReadonlyArray<CalendarPattern>, now: DateTime.Utc): DateTime.Utc | undefined => {
  let next: DateTime.Utc | undefined;
  for (const pattern of patterns) {
    const match = nextMatch(pattern, now, utc);
    if (match !== undefined && (next === undefined || DateTime.toEpochMillis(match) < DateTime.toEpochMillis(next))) next = match;
  }
  return next;
};

const eventOf = (workflow: NightWorkflow, run: CiRun, conclusion: string, now: DateTime.Utc, recheck: DateTime.Utc): NightlyEvent => ({
  schemaVersion: 1,
  rule: "nightly",
  at: DateTime.formatIso(now),
  repo: workflow.repo,
  workflow: workflow.workflow,
  runId: run.id,
  conclusion,
  home: workflow.home,
  recheckAt: DateTime.formatIso(recheck),
});

// A failed read ends no filing and clears none, so a repository it could not read keeps whatever the last good read filed.
export const nightlyStep = (
  state: NightlyState,
  sample: NightlySample,
  now: DateTime.Utc,
  settings: NightlySettings,
): Stepped<NightlyState, NightlyEvent> => {
  if (sample.kind !== "ok") return { state, events: [] };
  const { schedules, report } = sample.value;
  const unread = new Set(report.failures.map((failure) => failure.repo));
  const workflows = nightWorkflowsOf(schedules, settings).filter((workflow) => !unread.has(workflow.repo));
  const next = new Map(state);
  const events: Array<NightlyEvent> = [];
  for (const workflow of workflows) {
    const key = keyOf(workflow.repo, workflow.workflow);
    const decision = decisionOf(report.runs.filter((run) => run.repo === workflow.repo && run.workflow === workflow.workflow));
    if (decision === undefined) continue;
    if (!decision.failed) {
      next.delete(key);
      continue;
    }
    if (next.get(key) === decision.run.id) continue;
    const recheck = recheckOf(workflow.patterns, now);
    if (recheck === undefined) continue;
    next.set(key, decision.run.id);
    events.push(eventOf(workflow, decision.run, decision.conclusion, now, recheck));
  }
  return { state: next, events };
};
