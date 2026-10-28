import { DateTime, Option } from "effect";
import { type ActionRun, activeRuns, decodeActions, decodePueue, type Outcome, type QueueReadings, type QueuesView, queuesView } from "@tui-dash/schema";
import { fixture } from "./fixtures";

export const queuesNow = DateTime.makeUnsafe("2026-10-18T00:35:00Z");

const activeStatuses = ["requested", "pending", "waiting", "queued", "in_progress"] as const;

const runsFixture = (status: (typeof activeStatuses)[number]): string =>
  status === "in_progress" || status === "queued" ? fixture(`github/runs-${status}.json`) : fixture("github/runs-none.json");

const recordedRuns = (): Outcome<ReadonlyArray<ActionRun>> => activeRuns(activeStatuses.map((status) => decodeActions(runsFixture(status))));

export const fixtureActionsRepo = "example/toolshed";

export const queueAnswers: ReadonlyArray<readonly [string, string]> = [
  ["pueue status --json", fixture("pueue/status.json")],
  ...activeStatuses.map((status) => [`gh run list --repo ${fixtureActionsRepo} --status ${status} `, runsFixture(status)] as const),
];

export const fixtureQueueReadings = (machines: ReadonlyArray<string> = ["north"]): QueueReadings => ({
  machines: machines.map((name) => ({ name, status: Option.some(decodePueue(fixture("pueue/status.json"))) })),
  actions: { repo: fixtureActionsRepo, runs: Option.some(recordedRuns()) },
});

export const fixtureQueues = (machines: ReadonlyArray<string> = ["north"]): QueuesView => queuesView(fixtureQueueReadings(machines));
