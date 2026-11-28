import { DateTime } from "effect";
import { type Failed, failureOf, type Outcome, unreachable } from "../../../shared/lib";
import { withCaptured } from "../sources/capture";
import { type CountedCall, countedCalls, type Ledger } from "../sources/ledger";
import { resolveSessions, type Session, sessionLabel, type UnmatchedRuns } from "../sources/live";
import { sumTokens, type Tokens, tokenTotal } from "../contract/tokens";
import type { HarnessProcess, HerdrPane } from "../sources/live-sessions";
import type { QuotaAvailability, QuotaProviderId, QuotaWindow } from "../sources/quota";
import { type QuotaRead, type QuotaReadings, sourcedEntries } from "../sources/quota-read";
import type { SessionLogs, SinceByHarness } from "../sources/session-logs";
import { type AccountJoin, callJoin, credentialKeyOf, distinctJoins, keysOf } from "../sources/account-join";
import { byPricedShare, type Estimate, estimate, hourMillis, rateSpanHours, spendGate, verdictBeforeReset, type Weighed, weighed } from "./estimate";
import { accountTitle } from "./quotas";
import { localMidnight, type SessionModels, sessionModelsSinceMidnight } from "./session-models";
import type { SourcedEntry, SourcedProvider, SourcedWindow, WindowSource } from "../sources/window-sources";
import { presenceFieldsOf, presenceOf, type PresenceFields } from "./session-pane-presence";
import { uncycledFields } from "./uncycled-window";

interface ModelShare {
  readonly model: string | undefined;
  readonly calls: number;
  readonly tokens: Tokens;
  readonly trailingHourTokens: Tokens;
  readonly priced: Estimate;
}

export interface SessionShare {
  readonly session: Session;
  readonly label: string;
  readonly calls: number;
  readonly tokens: Tokens;
  readonly trailingHourTokens: Tokens;
  readonly raw: Estimate;
  readonly priced: Estimate;
  readonly models: ReadonlyArray<ModelShare>;
  readonly flagged: boolean;
}

interface WindowDetails {
  readonly id: string;
  readonly label: string;
  readonly kind: QuotaWindow["kind"];
  readonly source: WindowSource;
  readonly resetsAt: DateTime.Utc;
  readonly usedPoints: number;
  readonly leftPoints: number;
  readonly pace: NonNullable<QuotaWindow["pace"]>["status"];
  readonly aheadOfPace: boolean;
  readonly pastFirstTenth: boolean;
  readonly exhaustsBeforeReset: boolean;
  readonly verdict: boolean | null;
  readonly sustainablePointsPerHour: number | null;
  readonly activeSessions: number;
  readonly fairPointsPerHour: number | null;
  readonly observedCalls: number;
  readonly observedTokens: Tokens;
  readonly unattributedPoints: number;
  readonly sessions: ReadonlyArray<SessionShare>;
  readonly otherCycle: ReadonlyArray<string>;
}

export type WindowTiming =
  | { readonly cycleSeconds: number; readonly startsAt: DateTime.Utc; readonly elapsedFraction: number }
  | { readonly cycleSeconds: undefined; readonly startsAt: null; readonly elapsedFraction: null };

export type WindowView = WindowDetails & WindowTiming;

export interface AccountView {
  readonly provider: QuotaProviderId;
  readonly accountKey: string | undefined;
  readonly credentialKey: string | undefined;
  readonly accountKeys: ReadonlyArray<string>;
  readonly title: string;
  readonly joins: ReadonlyArray<AccountJoin>;
  readonly body: { readonly kind: "windows"; readonly windows: ReadonlyArray<WindowView> } | Failed;
}

export interface Unmetered {
  readonly route: string;
  readonly calls: number;
  readonly tokens: Tokens;
}

export type RemoteState =
  | {
      readonly kind: "ok";
      readonly generatedAt: DateTime.Utc;
      readonly quota: Failed | undefined;
      readonly panes: Failed | undefined;
      readonly processes: Failed | undefined;
    }
  | { readonly kind: "stale"; readonly generatedAt: DateTime.Utc }
  | Failed;

export interface RemoteMachine {
  readonly name: string;
  readonly state: RemoteState;
}

export interface FailedAccount {
  readonly machine: string;
  readonly account: Pick<AccountView, "provider" | "accountKey" | "credentialKey" | "title">;
  readonly failure: Failed;
}

export interface Composition {
  readonly local: string;
  readonly remotes: ReadonlyArray<RemoteMachine>;
  readonly failedAccounts: ReadonlyArray<FailedAccount>;
}

export interface SessionQuotaView extends PresenceFields {
  readonly now: DateTime.Utc;
  readonly quota: Failed | undefined;
  readonly panes: Failed | undefined;
  readonly processes: Failed | undefined;
  readonly accounts: ReadonlyArray<AccountView>;
  readonly sessions: ReadonlyArray<Session>;
  readonly modelsSinceMidnight: ReadonlyArray<SessionModels>;
  readonly unmatched: ReadonlyArray<UnmatchedRuns>;
  readonly ledger: Omit<Ledger, "calls">;
  readonly unmetered: ReadonlyArray<Unmetered>;
  readonly unjoinedCalls: number;
  readonly composition?: Composition;
}

export interface SessionQuotaInputs extends PresenceFields, QuotaReadings {
  readonly panes: Failed | undefined;
  readonly processes: Failed | undefined;
  readonly ledger: Ledger;
  readonly sessions: ReadonlyArray<Session>;
  readonly sessionOfFile: ReadonlyMap<string, string>;
  readonly unmatched: ReadonlyArray<UnmatchedRuns>;
  readonly now: DateTime.Utc;
  readonly timeZone: DateTime.TimeZone;
}

const firstTenth = 0.1;

const trackedKinds = new Set<QuotaWindow["kind"]>(["session", "weekly", "monthly", "unknown"]);

interface MeteredWindow {
  readonly window: SourcedWindow;
  readonly percentRemaining: number;
  readonly resetsAt: DateTime.Utc;
}

const meteredWindow = (window: SourcedWindow): MeteredWindow | undefined => {
  if (!("percentRemaining" in window) || window.resetsAt === undefined || !trackedKinds.has(window.kind)) return undefined;
  return { window, percentRemaining: window.percentRemaining, resetsAt: window.resetsAt };
};

const startOf = (metered: MeteredWindow, cycleSeconds: number): number => DateTime.toEpochMillis(metered.resetsAt) - cycleSeconds * 1000;

const liveEntries = (quota: QuotaRead, now: DateTime.Utc): ReadonlyArray<SourcedProvider> =>
  sourcedEntries(quota, now).flatMap((entry) => ("kind" in entry ? [] : [entry]));

const earliestStart = (entries: ReadonlyArray<SourcedProvider>, fallback: number): number =>
  Math.min(
    fallback,
    ...entries.flatMap((entry) => entry.windows.flatMap((window) => {
      const metered = meteredWindow(window);
      const cycleSeconds = window.pace?.cycleSeconds;
      return metered === undefined || cycleSeconds === undefined ? [] : [startOf(metered, cycleSeconds)];
    })),
  );

// Pi carries every provider, Claude Code only Claude and Codex rollouts only Codex, so each reads back only as far as its own windows start.
export const sessionLogsSince = (quota: QuotaRead, now: DateTime.Utc, timeZone: DateTime.TimeZone): SinceByHarness => {
  const entries = liveEntries(quota, now);
  const floor = Math.min(DateTime.toEpochMillis(now) - hourMillis, localMidnight(now, timeZone));
  return {
    pi: earliestStart(entries, floor),
    "claude-code": earliestStart(entries.filter((entry) => entry.provider === "claude"), floor),
    codex: earliestStart(entries.filter((entry) => entry.provider === "codex"), floor),
  };
};


const groupedBy = <K, V>(items: ReadonlyArray<V>, keyOf: (item: V) => K | undefined): ReadonlyMap<K, ReadonlyArray<V>> => {
  const groups = new Map<K, Array<V>>();
  for (const item of items) {
    const key = keyOf(item);
    if (key === undefined) continue;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  return groups;
};

// groupedBy drops a call with no key, and a call whose log names no model still counts in one row of its own.
const modelShares = (
  calls: ReadonlyArray<CountedCall>,
  hourCutoff: number,
  pricedWindow: (weighedCalls: Weighed) => Estimate,
): ReadonlyArray<ModelShare> =>
  [...Map.groupBy(calls, (call) => call.model).entries()]
    .map(([model, mine]) => ({
      model,
      calls: mine.length,
      tokens: sumTokens(mine.map((call) => call.tokens)),
      trailingHourTokens: sumTokens(mine.filter((call) => call.at >= hourCutoff).map((call) => call.tokens)),
      priced: pricedWindow(weighed(mine, hourCutoff, "priced")),
    }))
    .toSorted((a, b) => tokenTotal(b.tokens) - tokenTotal(a.tokens));

const windowView = (
  metered: MeteredWindow,
  calls: ReadonlyArray<CountedCall>,
  inputs: Pick<SessionQuotaInputs, "now" | "sessionOfFile">,
  sessionsById: ReadonlyMap<string, Session>,
  availability: ReadonlyArray<QuotaAvailability>,
): WindowView => {
  const usedPoints = 100 - metered.percentRemaining;
  const head = {
    id: metered.window.id,
    label: metered.window.label,
    kind: metered.window.kind,
    source: metered.window.source,
    resetsAt: metered.resetsAt,
    usedPoints,
    leftPoints: metered.percentRemaining,
    otherCycle: [],
  };
  const cycleSeconds = metered.window.pace?.cycleSeconds;
  if (cycleSeconds === undefined) return { ...head, ...uncycledFields(usedPoints) };
  const now = DateTime.toEpochMillis(inputs.now);
  const start = startOf(metered, cycleSeconds);
  const resetsAt = DateTime.toEpochMillis(metered.resetsAt);
  // quota-axi can hand back a window that has already reset, and calls after its reset belong to the next cycle.
  const end = Math.min(now, resetsAt);
  const hourCutoff = now - hourMillis;
  const spanHours = rateSpanHours(start, resetsAt, now);
  const inWindow = calls.filter((call) => call.at >= start && call.at < resetsAt && call.at <= now);
  const bySession = groupedBy(inWindow, (call) => inputs.sessionOfFile.get(call.file));
  const all = { raw: weighed(inWindow, hourCutoff, "raw"), priced: weighed(inWindow, hourCutoff, "priced") };
  const rows = [...bySession.entries()].flatMap(([id, mine]) => {
    const session = sessionsById.get(id);
    if (session === undefined) return [];
    const raw = weighed(mine, hourCutoff, "raw");
    const priced = weighed(mine, hourCutoff, "priced");
    return [
      {
        session,
        label: sessionLabel(session),
        calls: mine.length,
        tokens: sumTokens(mine.map((call) => call.tokens)),
        trailingHourTokens: sumTokens(mine.filter((call) => call.at >= hourCutoff).map((call) => call.tokens)),
        raw: estimate(raw, all.raw.window, usedPoints, spanHours),
        priced: estimate(priced, all.priced.window, usedPoints, spanHours),
        models: modelShares(mine, hourCutoff, (model) => estimate(model, all.priced.window, usedPoints, spanHours)),
      },
    ];
  });
  const elapsedFraction = (end - start) / (cycleSeconds * 1000);
  const pace = now < resetsAt ? (metered.window.pace?.status ?? "unknown") : "unknown";
  const aheadOfPace = pace === "ahead";
  const pastFirstTenth = elapsedFraction >= firstTenth;
  const sustainablePointsPerHour =
    now < resetsAt ? metered.percentRemaining / Math.max((resetsAt - now) / hourMillis, 1 / 60) : null;
  const verdict = metered.window.source.kind === "quota-axi" ? verdictBeforeReset(availability, metered.window.id, resetsAt) : null;
  const gate = spendGate(rows, aheadOfPace && pastFirstTenth, sustainablePointsPerHour, verdict);
  return {
    ...head,
    cycleSeconds,
    startsAt: DateTime.makeUnsafe(start),
    pace,
    elapsedFraction,
    aheadOfPace,
    pastFirstTenth,
    exhaustsBeforeReset: gate.exhaustsBeforeReset,
    verdict,
    sustainablePointsPerHour,
    activeSessions: gate.burning,
    fairPointsPerHour: gate.fairPointsPerHour,
    observedCalls: inWindow.length,
    observedTokens: sumTokens(inWindow.map((call) => call.tokens)),
    unattributedPoints: inWindow.length === 0 ? usedPoints : 0,
    sessions: rows
      .toSorted(byPricedShare)
      .map((row) => ({ ...row, flagged: gate.flagged.has(row.session) })),
  };
};

interface AccountContext {
  readonly entries: ReadonlyArray<SourcedEntry>;
  readonly inputs: Pick<SessionQuotaInputs, "now" | "sessionOfFile" | "quota" | "orcQuota">;
  readonly sessionsById: ReadonlyMap<string, Session>;
}

const unreadStates = new Set<SourcedProvider["state"]["status"]>(["unavailable", "auth_required", "rate_limited", "error"]);

const unreadBody = ({ provider, state }: SourcedProvider): Failed =>
  unreachable(`quota-axi reads ${provider} as ${state.status}${state.error === undefined ? "" : `: ${state.error}`}`);

export const accountView = (
  entry: SourcedEntry,
  joined: ReadonlyArray<{ readonly call: CountedCall; readonly join: AccountJoin }>,
  { entries, inputs, sessionsById }: AccountContext,
): AccountView => {
  const joins = distinctJoins(joined.map(({ join }) => join));
  const head = {
    provider: entry.provider,
    accountKey: entry.accountKey,
    credentialKey: credentialKeyOf(entry),
    accountKeys: keysOf(entry),
    title: accountTitle(entry, inputs.orcQuota, entries, inputs.quota.accounts),
    joins,
  };
  if ("kind" in entry) return { ...head, body: failureOf(entry) };
  const calls = joined.map(({ call }) => call);
  const availability = entry.state.stale ? [] : entry.quotaSemantics?.effectiveAvailability ?? [];
  const windows = entry.windows.flatMap((window) => {
    const metered = meteredWindow(window);
    return metered === undefined ? [] : [windowView(metered, calls, inputs, sessionsById, availability)];
  });
  if (windows.length === 0 && unreadStates.has(entry.state.status)) return { ...head, body: unreadBody(entry) };
  return { ...head, body: { kind: "windows", windows } };
};

const unmeteredOf = (calls: ReadonlyArray<CountedCall>): ReadonlyArray<Unmetered> =>
  [...groupedBy(calls, (call) => call.route).entries()].map(([route, routed]) => ({
    route,
    calls: routed.length,
    tokens: sumTokens(routed.map((call) => call.tokens)),
  }));

export const sessionQuotaView = (inputs: SessionQuotaInputs): SessionQuotaView => {
  const { calls, ...counts } = inputs.ledger;
  const entries = sourcedEntries(inputs.quota, inputs.now);
  const context: AccountContext = {
    entries,
    inputs,
    sessionsById: new Map(inputs.sessions.map((session) => [session.id, session])),
  };
  const metered = calls.flatMap((call) =>
    call.quota === undefined
      ? []
      : [{ call, joined: callJoin({ provider: call.quota, credentialKey: call.credentialKey }, entries, inputs.quota.logAccounts) }],
  );
  const joinedByEntry = groupedBy(metered, ({ joined }) => joined?.entry);
  const unjoinedCalls = metered.filter(({ joined }) => joined === undefined).length;
  return {
    now: inputs.now,
    quota: inputs.quota.quotaAxi.kind === "ok" ? undefined : failureOf(inputs.quota.quotaAxi),
    panes: inputs.panes,
    processes: inputs.processes,
    accounts: entries.map((entry) =>
      accountView(
        entry,
        (joinedByEntry.get(entry) ?? []).flatMap(({ call, joined }) => (joined === undefined ? [] : [{ call, join: joined.join }])),
        context,
      ),
    ),
    sessions: inputs.sessions,
    ...presenceFieldsOf(inputs),
    modelsSinceMidnight: sessionModelsSinceMidnight(calls, inputs, context.sessionsById),
    unmatched: inputs.unmatched,
    ledger: counts,
    unmetered: unmeteredOf(calls.filter((call) => call.quota === undefined)),
    unjoinedCalls,
  };
};

export interface SessionQuotaReadings extends QuotaReadings {
  readonly panes: Outcome<ReadonlyArray<HerdrPane>>;
  readonly processes: Outcome<ReadonlyArray<HarnessProcess>>;
  readonly logs: SessionLogs;
  readonly now: DateTime.Utc;
  readonly timeZone: DateTime.TimeZone;
}

const failedOrNone = <A>(outcome: Outcome<A>): Failed | undefined =>
  outcome.kind === "ok" ? undefined : failureOf(outcome);

export const sessionQuotaFrom = (readings: SessionQuotaReadings): SessionQuotaView => {
  const files = withCaptured(readings.logs.files, readings.logs.captured.calls);
  const ledger = countedCalls(files);
  const { sessions, sessionOfFile, unmatched, headless } = resolveSessions(files, ledger.calls, {
    home: readings.logs.home,
    roots: readings.logs.roots,
    panes: readings.panes.kind === "ok" ? readings.panes.value : [],
    processes: readings.processes.kind === "ok" ? readings.processes.value : [],
  });
  const presence = presenceOf(readings.panes, readings.logs.roots, files, headless);
  return sessionQuotaView({
    quota: readings.quota,
    orcQuota: readings.orcQuota,
    panes: failedOrNone(readings.panes),
    processes: failedOrNone(readings.processes),
    ledger,
    sessions,
    ...presence,
    sessionOfFile,
    unmatched,
    now: readings.now,
    timeZone: readings.timeZone,
  });
};
