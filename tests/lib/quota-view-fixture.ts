import { DateTime } from "effect";
import {
  type CountedCall,
  decodeSavedProfiles,
  decodeQuota,
  type Ledger,
  type Session,
  type SessionQuotaView,
  sessionQuotaView,
  type WindowView,
} from "@tui-dash/schema";
import { fixture } from "./fixtures";
import { quotaAxiRead } from "./quota-read";

export const hour = 3_600_000;

export const reset = Date.parse("2026-10-16T17:00:00Z");

const iso = (millis: number) => new Date(millis).toISOString();

type ScenarioRunway = "projected_exhaustion" | "early" | "through_reset";

export interface Scenario {
  readonly now: number;
  readonly weekStatus: "ahead" | "on_pace";
  readonly weekLeft: number;
  readonly weekRunway?: ScenarioRunway;
  readonly weekStale?: boolean;
  readonly monthStatus?: "ahead" | "on_pace";
  readonly timeZone?: DateTime.TimeZone;
}

const monthReset = reset + 20 * 24 * hour;

const runwayJson = (status: ScenarioRunway | undefined, limitingWindowId: string, now: number): unknown => {
  switch (status) {
    case undefined:
      return undefined;
    case "projected_exhaustion":
      return {
        status,
        limitingWindowId,
        projectedExhaustedAt: iso(now + 2 * 24 * hour),
        usableRunwaySeconds: 2 * 24 * 3600,
        projectionConfidence: "established",
      };
    case "through_reset":
      return { status, limitingWindowId };
    case "early":
      return {
        status: "projected_exhaustion",
        limitingWindowId,
        projectedExhaustedAt: iso(now + 2 * 24 * hour),
        usableRunwaySeconds: 2 * 24 * 3600,
        projectionConfidence: "early",
      };
  }
};

const quotaReport = ({ now, weekStatus, weekLeft, weekRunway, weekStale = false, monthStatus = "on_pace" }: Scenario) =>
  JSON.stringify({
    generatedAt: iso(now),
    schemaVersion: 5,
    providers: [
      {
        provider: "claude",
        ...(weekRunway === undefined
          ? {}
          : {
              quotaSemantics: {
                status: "known",
                effectiveAvailability: [{ scope: "all_models", status: "known", runway: runwayJson(weekRunway, "seven_day", now) }],
              },
            }),
        windows: [
          {
            id: "seven_day",
            label: "week",
            kind: "weekly",
            percentRemaining: weekLeft,
            resetsAt: iso(reset + 7 * 24 * hour),
            pace: { status: weekStatus, cycleSeconds: 604800 },
          },
          {
            id: "model:fable",
            label: "Fable week",
            kind: "model",
            percentRemaining: 100,
            resetsAt: iso(reset + 7 * 24 * hour),
            pace: { status: "behind", cycleSeconds: 604800 },
          },
        ],
        state: weekStale ? { status: "stale", stale: true } : { status: "fresh", stale: false },
      },
      {
        provider: "codex",
        windows: [
          {
            id: "weekly",
            label: "week",
            kind: "weekly",
            percentRemaining: 53,
            resetsAt: iso(reset + 5 * 24 * hour),
            pace: { status: "ahead", cycleSeconds: 604800 },
          },
        ],
        state: { status: "fresh", stale: false },
      },
      {
        provider: "opencode-go",
        windows: [
          {
            id: "monthly",
            label: "month",
            kind: "monthly",
            percentRemaining: 66,
            resetsAt: iso(monthReset),
            pace: { status: monthStatus, cycleSeconds: 2592000 },
          },
        ],
        state: { status: "fresh", stale: false },
      },
    ],
  });

const pane = (name: string): Session => ({
  id: `pane:${name}`,
  identity: { kind: "pane", pane: name, status: "working" },
  harness: "pi",
  cwd: `/work/${name}`,
  place: `/work/${name}`,
  files: [`/logs/${name}.jsonl`],
});

export const ended = (name: string): Session => ({ ...pane(name), id: `file:${name}`, identity: { kind: "ended" } });

export const call = (session: Session, at: number, input: number): CountedCall => ({
  file: session.files[0] ?? "",
  harness: "pi",
  at,
  route: "claude-bridge",
  quota: "claude",
  credentialKey: undefined,
  model: "claude-opus-5-5",
  tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
});

export const ledgerOf = (calls: ReadonlyArray<CountedCall>): Ledger => ({
  calls,
  bridgeCopiesDropped: 0,
  repeatedLinesDropped: 0,
  emptyRowsDropped: 0,
  forkCopiesDropped: 0,
  repeatedCountsDropped: 0,
});

export const viewOf = (scenario: Scenario, sessions: ReadonlyArray<Session>, calls: ReadonlyArray<CountedCall>): SessionQuotaView => {
  const quota = decodeQuota(quotaReport(scenario));
  const savedProfiles = decodeSavedProfiles(fixture("saved-profiles/status.json"));
  const now = DateTime.makeUnsafe(scenario.now);
  return sessionQuotaView({
    quota: quotaAxiRead({ ...quota, capturedAt: now }),
    savedProfiles: { ...savedProfiles, capturedAt: now },
    panes: undefined,
    processes: undefined,
    ledger: ledgerOf(calls),
    sessions,
    sessionOfFile: new Map(sessions.map((session) => [session.files[0] ?? "", session.id])),
    unmatched: [],
    now,
    timeZone: scenario.timeZone ?? DateTime.zoneMakeNamedUnsafe("UTC"),
  });
};

export const windowOf = (view: SessionQuotaView, provider: string, id: string): WindowView => {
  const account = view.accounts.find((candidate) => candidate.provider === provider);
  if (account?.body.kind !== "windows") throw new Error(`no ${provider} windows`);
  const window = account.body.windows.find((candidate) => candidate.id === id);
  if (window === undefined) throw new Error(`no ${provider} ${id} window`);
  return window;
};

export const six = ["a", "b", "c", "d", "e", "f"].map(pane);

export const fifthIn = reset + 0.2 * 7 * 24 * hour;
