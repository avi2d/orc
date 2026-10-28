import { Context, DateTime, Duration, Effect, Layer, Option, Schema } from "effect";
import { CommandRunner } from "../command";
import { type Decoded, decodeJson } from "../decode";
import { type Failed, ok, type Outcome, type Reading } from "../reading";
import { runDecoded, stamped } from "../source";
import { RunnerRepos } from "./runners";

const Instant = Schema.DateTimeUtcFromString;

const RunJson = Schema.Struct({
  id: Schema.Int,
  name: Schema.NullOr(Schema.String),
  head_branch: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.String),
  conclusion: Schema.NullOr(Schema.String),
  created_at: Instant,
  updated_at: Instant,
});

const RunsJson = Schema.Struct({ workflow_runs: Schema.Array(RunJson) });

const JobJson = Schema.Struct({
  started_at: Schema.NullOr(Instant),
  completed_at: Schema.NullOr(Instant),
  runner_name: Schema.NullOr(Schema.String),
});

const JobsJson = Schema.Struct({ jobs: Schema.Array(JobJson) });

type RunJson = typeof RunJson.Type;

type JobJson = typeof JobJson.Type;

export const decodeCiRuns: (stdout: string) => Decoded<ReadonlyArray<RunJson>> = (stdout) => {
  const runs = decodeJson(RunsJson)(stdout);
  return runs.kind === "ok" ? { kind: "ok", value: runs.value.workflow_runs } : runs;
};

export const decodeCiJobs: (stdout: string) => Decoded<ReadonlyArray<JobJson>> = (stdout) => {
  const jobs = decodeJson(JobsJson)(stdout);
  return jobs.kind === "ok" ? { kind: "ok", value: jobs.value.jobs } : jobs;
};

export type CiStatus = "waiting" | "running" | "done";

export interface JobSpan {
  readonly startedAt: DateTime.Utc;
  readonly endedAt: DateTime.Utc | undefined;
}

export interface CiRun {
  readonly repo: string;
  readonly id: number;
  readonly workflow: string;
  readonly branch: string | undefined;
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
  readonly status: CiStatus;
  readonly conclusion: string | undefined;
  readonly jobs: JobSpan | undefined;
}

export interface RepoFailure {
  readonly repo: string;
  readonly failure: Failed;
}

export interface CiReport {
  readonly repos: ReadonlyArray<string>;
  readonly runs: ReadonlyArray<CiRun>;
  readonly failures: ReadonlyArray<RepoFailure>;
}

const statusOf = (status: string | null): CiStatus => {
  if (status === "completed") return "done";
  return status === "in_progress" ? "running" : "waiting";
};

const millis = DateTime.toEpochMillis;

// A skipped job carries times but never reached a runner, so only jobs a runner took count toward the span.
export const jobSpan = (jobs: ReadonlyArray<JobJson>): JobSpan | undefined => {
  const ran = jobs.flatMap((job) => (job.runner_name === null || job.started_at === null ? [] : [{ startedAt: job.started_at, endedAt: job.completed_at }]));
  if (ran.length === 0) return undefined;
  const startedAt = ran.reduce((earliest, job) => (millis(job.startedAt) < millis(earliest) ? job.startedAt : earliest), ran.at(0)?.startedAt ?? DateTime.makeUnsafe(0));
  const open = ran.some((job) => job.endedAt === null);
  const ends = ran.flatMap((job) => (job.endedAt === null ? [] : [job.endedAt]));
  const endedAt = open || ends.length === 0 ? undefined : ends.reduce((latest, end) => (millis(end) > millis(latest) ? end : latest));
  return { startedAt, endedAt };
};

const runOf = (repo: string, run: RunJson, jobs: JobSpan | undefined): CiRun => ({
  repo,
  id: run.id,
  workflow: run.name ?? "unnamed workflow",
  branch: run.head_branch ?? undefined,
  createdAt: run.created_at,
  updatedAt: run.updated_at,
  status: statusOf(run.status),
  conclusion: run.conclusion ?? undefined,
  jobs,
});

const apiTimeout = Duration.seconds(20);

const runsWindow = Duration.days(1);

const runsCommand = (repo: string, since: DateTime.Utc) =>
  ({
    argv: ["gh", "api", `repos/${repo}/actions/runs?per_page=50&created=${encodeURIComponent(`>=${DateTime.formatIso(since)}`)}`],
    timeout: apiTimeout,
  }) as const;

const jobsCommand = (repo: string, id: number) =>
  ({ argv: ["gh", "api", `repos/${repo}/actions/runs/${id}/jobs?per_page=100`], timeout: apiTimeout }) as const;

// Each run past these costs one more call a read against GitHub's hourly limit, so older runs show without their job times.
const jobsRead = 40;

const jobsAtOnce = 8;

const keyOf = (repo: string, id: number): string => `${repo}#${id}`;

interface Listed {
  readonly repo: string;
  readonly run: RunJson;
}

const newestFirst = (left: Listed, right: Listed): number => millis(right.run.created_at) - millis(left.run.created_at);

// A finished run's jobs never change, so its span is read once and kept while the run is still listed.
const ciReport = (
  repos: ReadonlyArray<string>,
  listings: ReadonlyArray<{ readonly repo: string; readonly runs: Outcome<ReadonlyArray<RunJson>> }>,
  spans: Map<string, JobSpan | undefined>,
): Effect.Effect<CiReport, never, CommandRunner> =>
  Effect.gen(function* () {
    const listed = listings.flatMap(({ repo, runs }) => (runs.kind === "ok" ? runs.value.map((run) => ({ repo, run })) : [])).toSorted(newestFirst);
    const kept = new Set(listed.map(({ repo, run }) => keyOf(repo, run.id)));
    for (const key of spans.keys()) if (!kept.has(key)) spans.delete(key);
    const wanted = listed.filter(({ repo, run }, index) => statusOf(run.status) === "running" || (index < jobsRead && !spans.has(keyOf(repo, run.id))));
    const read = yield* Effect.forEach(wanted, ({ repo, run }) => Effect.map(runDecoded(jobsCommand(repo, run.id), decodeCiJobs), (jobs) => ({ repo, run, jobs })), {
      concurrency: jobsAtOnce,
    });
    const fresh = new Map<string, JobSpan | undefined>();
    for (const { repo, run, jobs } of read) {
      if (jobs.kind !== "ok") continue;
      const span = jobSpan(jobs.value);
      fresh.set(keyOf(repo, run.id), span);
      if (statusOf(run.status) === "done") spans.set(keyOf(repo, run.id), span);
    }
    return {
      repos,
      runs: listed.map(({ repo, run }) => runOf(repo, run, fresh.get(keyOf(repo, run.id)) ?? spans.get(keyOf(repo, run.id)))),
      failures: listings.flatMap(({ repo, runs }) => (runs.kind === "ok" ? [] : [{ repo, failure: runs }])),
    };
  });

export interface CiRunsReading {
  readonly read: Effect.Effect<Reading<CiReport>>;
}

export class CiRuns extends Context.Service<CiRuns, Option.Option<CiRunsReading>>()("tui-dash/CiRuns") {}

// Every repository costs a call a read against GitHub's hourly limit, so a screen repainting every 10 seconds reuses a read this young.
const reuseFor = Duration.seconds(60);

export const ciRunsLayer: Layer.Layer<CiRuns, never, CommandRunner | RunnerRepos> = Layer.effect(
  CiRuns,
  Effect.gen(function* () {
    const repos = yield* RunnerRepos;
    if (Option.isNone(repos)) return Option.none();
    const runner = yield* CommandRunner;
    const spans = new Map<string, JobSpan | undefined>();
    const read = stamped(
      Effect.gen(function* () {
        const listing = yield* repos.value.read;
        if (listing.kind !== "ok") return listing;
        const since = DateTime.subtractDuration(yield* DateTime.now, runsWindow);
        const listings = yield* Effect.forEach(listing.value, (repo) => Effect.map(runDecoded(runsCommand(repo, since), decodeCiRuns), (runs) => ({ repo, runs })), {
          concurrency: "unbounded",
        });
        return ok(yield* ciReport(listing.value, listings, spans));
      }),
    );
    return Option.some({ read: yield* Effect.cachedWithTTL(Effect.provideService(read, CommandRunner, runner), reuseFor) });
  }),
);
