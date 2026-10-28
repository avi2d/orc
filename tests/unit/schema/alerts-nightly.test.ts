import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import {
  cronPattern,
  nightlyStart,
  nightlyStep,
  type CiReport,
  type CiRun,
  type CronSchedule,
  type NightlySample,
  type NightlySettings,
  ok,
  type ScheduleRead,
} from "@tui-dash/schema";

const at = (iso: string): DateTime.Utc => DateTime.makeUnsafe(iso);

const now = at("2026-10-27T09:00:00Z");

const settings: NightlySettings = {
  everySeconds: 300,
  homes: {
    "example/website": "my-website",
    "example/socials": "my-socials",
    "example/ru-compliance": "my-ru-compliance",
  },
};

const cron = (repo: string, name: string, expression: string): CronSchedule => {
  const pattern = cronPattern(expression);
  if (pattern === undefined) throw new Error("not a cron: " + expression);
  return { kind: "CI", name, repo, pattern };
};

const oracleCrons: ReadonlyArray<CronSchedule> = [
  cron("example/website", "night-run", "1 3 * * 0,3"),
  cron("example/website", "iphone-night", "30 2 * * *"),
  cron("example/socials", "night-run", "0 3 * * *"),
  cron("example/ru-compliance", "night-run", "15 4 * * *"),
];

const run = (repo: string, workflow: string, id: number, createdAt: string, conclusion: string | undefined): CiRun => ({
  repo,
  id,
  workflow,
  branch: "main",
  createdAt: at(createdAt),
  updatedAt: at(createdAt),
  status: "done",
  conclusion,
  jobs: undefined,
});

const oracleRuns: ReadonlyArray<CiRun> = [
  run("example/website", "night-run", 101, "2026-10-27T03:05:00Z", "failure"),
  run("example/website", "iphone-night", 102, "2026-10-27T02:35:00Z", "timed_out"),
  run("example/socials", "night-run", 103, "2026-10-27T03:04:00Z", "failure"),
  run("example/ru-compliance", "night-run", 104, "2026-10-27T04:20:00Z", "failure"),
];

const schedulesOf = (crons: ReadonlyArray<CronSchedule>): ScheduleRead => ({ source: "CI", outcome: ok(crons), unread: [] });

const reportOf = (runs: ReadonlyArray<CiRun>): CiReport => ({ repos: [...new Set(runs.map((entry) => entry.repo))], runs, failures: [] });

const sampleOf = (crons: ReadonlyArray<CronSchedule>, runs: ReadonlyArray<CiRun>): NightlySample => ok({ schedules: [schedulesOf(crons)], report: reportOf(runs) });

const oracleSample: NightlySample = sampleOf(oracleCrons, oracleRuns);

const summaryOf = (sample: NightlySample, from = nightlyStart) => nightlyStep(from, sample, now, settings);

describe("the nightly rule on the 2026-10-27 red night runs", () => {
  test("files one fix task per red night workflow with its owner home and recheck date", () => {
    const { events } = summaryOf(oracleSample);
    expect(
      events.map((event) => [event.repo, event.workflow, event.runId, event.conclusion, event.home, event.recheckAt]),
    ).toEqual([
      ["example/website", "night-run", 101, "failure", "my-website", "2026-10-28T03:01:00.000Z"],
      ["example/website", "iphone-night", 102, "timed_out", "my-website", "2026-10-28T02:30:00.000Z"],
      ["example/socials", "night-run", 103, "failure", "my-socials", "2026-10-28T03:00:00.000Z"],
      ["example/ru-compliance", "night-run", 104, "failure", "my-ru-compliance", "2026-10-28T04:15:00.000Z"],
    ]);
  });

  test("files nothing twice for the same red run", () => {
    const first = summaryOf(oracleSample);
    expect(summaryOf(oracleSample, first.state).events).toEqual([]);
  });

  test("refiles when the next night run goes red again after a green one", () => {
    const filed = summaryOf(oracleSample);
    const green = run("example/socials", "night-run", 105, "2026-10-28T03:04:00Z", "success");
    const cleared = summaryOf(sampleOf(oracleCrons, [green, ...oracleRuns]), filed.state);
    expect(cleared.events).toEqual([]);
    const redAgain = run("example/socials", "night-run", 106, "2026-10-29T03:04:00Z", "failure");
    const { events } = summaryOf(sampleOf(oracleCrons, [redAgain, green, ...oracleRuns]), cleared.state);
    expect(events.map((event) => [event.repo, event.workflow, event.runId])).toEqual([["example/socials", "night-run", 106]]);
  });

  test("ignores a red workflow on a day schedule instead of filing a night fix", () => {
    const lunch = cron("example/website", "lunch", "0 12 * * *");
    const red = run("example/website", "lunch", 107, "2026-10-27T12:05:00Z", "failure");
    expect(summaryOf(sampleOf([lunch], [red])).events).toEqual([]);
  });

  test("holds a red night run with no mapped owner home instead of filing it nowhere", () => {
    const unowned = cron("example/notes", "night-run", "0 3 * * *");
    const red = run("example/notes", "night-run", 108, "2026-10-27T03:06:00Z", "failure");
    expect(summaryOf(sampleOf([unowned], [red])).events).toEqual([]);
  });

  test("keeps the one filing while a rerun cancels instead of fixing the red", () => {
    const filed = summaryOf(oracleSample);
    const cancelled: CiRun = { ...run("example/socials", "night-run", 109, "2026-10-27T10:00:00Z", "cancelled"), status: "done" };
    expect(summaryOf(sampleOf(oracleCrons, [cancelled, ...oracleRuns]), filed.state).events).toEqual([]);
  });

  test("keeps its filings across a failed read instead of filing everything again", () => {
    const filed = summaryOf(oracleSample);
    const kept = summaryOf({ kind: "unreachable", reason: "gh gave no answer" }, filed.state);
    expect(kept.events).toEqual([]);
    expect(summaryOf(oracleSample, kept.state).events).toEqual([]);
  });

  test("skips a schedule line it cannot parse instead of guessing its night hours", () => {
    const unknown: CronSchedule = { kind: "CI", name: "night-run", repo: "example/website", pattern: undefined };
    const red = run("example/website", "night-run", 110, "2026-10-27T03:05:00Z", "failure");
    expect(summaryOf(sampleOf([unknown], [red])).events).toEqual([]);
  });
});
