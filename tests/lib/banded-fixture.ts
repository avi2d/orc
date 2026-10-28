import { DateTime, Option } from "effect";
import type { AlertReadings } from "@tui-dash/alerts";
import type { SaidMessage } from "@tui-dash/ledger";
import type { CiShown } from "@tui-dash/queues";
import {
  type CiReport,
  cronPattern,
  type Decoded,
  decodePueue,
  type MachineListing,
  machinesView,
  type MachinesView,
  ok,
  type PueueStatus,
  type QueueReadings,
  type QuotaBlock,
  type Reading,
  type ScheduleRead,
  type SessionQuotaView,
  type TaskLevels,
  type TaskListing,
  taskLevels,
} from "@tui-dash/schema";
import { recordedAlerts } from "./alerts-fixture";
import { dashboardNow, quotaBlocksOf, recordedResources, southResources } from "./dashboard-fixture";
import { fixture } from "./fixtures";
import { fixtureSessionView } from "./session-fixture";
import { southTaskReadings, taskReadings } from "./task-levels-fixture";

const utc = DateTime.zoneMakeNamedUnsafe("UTC");

const minutesFromNow = (minutes: number) => DateTime.addDuration(dashboardNow, `${minutes} minutes`);

const run = (id: number, workflow: string, status: "waiting" | "running" | "done", conclusion: string | undefined, endedMinutesAgo: number, tookMinutes: number) => ({
  repo: "example/shop",
  id,
  workflow,
  branch: "main",
  createdAt: minutesFromNow(-endedMinutesAgo - tookMinutes - 1),
  updatedAt: minutesFromNow(-endedMinutesAgo),
  status,
  conclusion,
  jobs: status === "waiting" ? undefined : { startedAt: minutesFromNow(-endedMinutesAgo - tookMinutes), endedAt: status === "done" ? minutesFromNow(-endedMinutesAgo) : undefined },
});

const fixtureSchedules: ReadonlyArray<ScheduleRead> = [
  {
    source: "timer",
    outcome: ok([
      { kind: "timer", name: "backup", next: minutesFromNow(12) },
      { kind: "timer", name: "logrotate", next: minutesFromNow(220) },
    ]),
    unread: [],
  },
  {
    source: "CI",
    outcome: ok([
      { kind: "CI", name: "nightly", repo: "example/shop", pattern: cronPattern("0 3 * * *") },
      { kind: "CI", name: "nightly", repo: "example/notes", pattern: cronPattern("0 3 * * *") },
    ]),
    unread: [{ repo: "example/blog", failure: { kind: "unreachable", reason: "gh api answered 502" } }],
  },
];

// The recorded pueue status moved to 25 minutes before the frame, so its runs fall within the queue's last day.
const fixturePueue = (): Decoded<PueueStatus> => decodePueue(pueueStatus());

const pueueStatus = () => fixture("pueue/status.json").replaceAll("2026-10-18T03:23", "2026-10-13T22:53");

// South runs one task of its own, so the shared queue box names a machine per row.
const southPueue = (): Decoded<PueueStatus> =>
  decodePueue(
    JSON.stringify({
      tasks: { "7": { id: 7, command: "bun test", path: "/home/example/work/kelp", status: { Running: { start: "2026-10-13T22:50:00Z" } } } },
      groups: { default: { status: "Running", parallel_tasks: 1 } },
    }),
  );

const fixtureCi = (): Reading<CiReport> => ({
  ...ok({
    repos: ["example/blog", "example/shop"],
    runs: [run(21, "ci", "running", undefined, 0, 3), run(22, "deploy", "waiting", undefined, 0, 0), run(20, "ci", "done", "failure", 50, 2)],
    failures: [{ repo: "example/blog", failure: { kind: "unreachable", reason: "gh api answered 502" } }],
  }),
  capturedAt: dashboardNow,
});

const weeklyReview = { name: "weekly review", at: minutesFromNow(600), detail: "" };

// The orchestrator's own schedule is the one entry the fixture names for it.
const orchestratorListing = (listing: TaskListing): TaskListing =>
  listing.kind === "ok" ? ok({ ...listing.value, view: { ...listing.value.view, schedules: [weeklyReview] } }) : listing;

// What each panel module reads, before the module shapes it for its box.
export interface BandedReadings {
  readonly ledger: ReadonlyArray<SaidMessage>;
  readonly blocks: ReadonlyArray<QuotaBlock>;
  readonly sessions: Option.Option<SessionQuotaView>;
  readonly machines: Option.Option<MachinesView>;
  readonly queues: QueueReadings;
  readonly alerts: AlertReadings;
  readonly now: DateTime.Utc;
  readonly tasks: {
    readonly levels: TaskLevels;
    readonly byMachine: ReadonlyMap<string, TaskLevels>;
    readonly zone: DateTime.TimeZone;
  };
  readonly listings: ReadonlyArray<MachineListing>;
  readonly ci: CiShown;
  readonly schedules: Option.Option<ReadonlyArray<ScheduleRead>>;
}

export const bandedReadings = (local = "north"): BandedReadings => ({
  ledger: [
    { id: "m-early", at: minutesFromNow(-300), who: { role: "you" as const }, text: "Ship the ledger board today." },
    { id: "m-plan", at: minutesFromNow(-290), who: { role: "agent" as const, name: "assistant" }, text: "The compact box keeps one line per message." },
    { id: "m-ask", at: minutesFromNow(-120), who: { role: "you" as const }, text: "Does l open the full screen?" },
    {
      id: "m-full",
      at: minutesFromNow(-25),
      who: { role: "agent" as const, name: "assistant" },
      text: "Yes. l takes the full screen, and the cursor opens a message for the full text:\nits wrapped words stay readable beside the time.",
    },
  ],
  blocks: quotaBlocksOf(fixture("quota-axi/full.json")),
  sessions: Option.some(fixtureSessionView()),
  machines: Option.some(machinesView({ name: local, view: recordedResources() }, [{ name: "south", reading: ok(southResources()) }], dashboardNow)),
  queues: {
    machines: [
      { name: local, status: Option.some(fixturePueue()) },
      { name: "south", status: Option.some(southPueue()) },
    ],
    actions: { repo: "example/shop", runs: Option.some(ok([])) },
  },
  alerts: recordedAlerts(),
  now: dashboardNow,
  tasks: {
    levels: taskLevels({ ...taskReadings({ machine: local }), interval: "all" }),
    byMachine: new Map([
      [local, taskLevels({ ...taskReadings({ machine: local }), interval: "all" })],
      ["south", taskLevels({ ...southTaskReadings(), interval: "all" })],
    ]),
    zone: utc,
  },
  listings: [{ machine: local, listing: orchestratorListing(taskReadings({ machine: local }).tasks) }],
  ci: { kind: "live", value: fixtureCi(), at: DateTime.toEpochMillis(dashboardNow) },
  schedules: Option.some(fixtureSchedules),
});
