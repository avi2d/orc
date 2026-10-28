import { DateTime } from "effect";
import { type Failed, failureOf, type Outcome, type Reading } from "../reading";
import { withCaptured } from "../sessions/capture";
import { type CountedCall, countedCalls, type Ledger } from "../sessions/ledger";
import { resolveSessions, type Session, sessionLabel, type UnmatchedRuns } from "../sessions/live";
import { sumTokens, type Tokens, tokenTotal } from "../sessions/tokens";
import type { SavedProfiles } from "../sources/saved-profiles";
import type { HarnessProcess, HerdrPane } from "../sources/live-sessions";
import type { QuotaAvailability, QuotaProviderId, QuotaWindow } from "../sources/quota";
import { type QuotaRead, sourcedEntries } from "../sources/quota-read";
import type { SessionLogs, SinceByHarness } from "../sources/session-logs";
import { type AccountJoin, callJoin, credentialKeyOf, keysOf, sameJoin } from "./account-join";
import { byPricedShare, type Estimate, estimate, hourMillis, rateSpanHours, spendGate, verdictBeforeReset, type Weighed, weighed } from "./estimate";
import { accountTitle } from "./quotas";
import { localMidnight, type SessionModels, sessionModelsSinceMidnight } from "./session-models";
import type { SourcedEntry, SourcedProvider, SourcedWindow, WindowSource } from "./window-sources";
import { presenceFieldsOf, presenceOf, type PresenceFields } from "./session-pane-presence";

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

export interface WindowView {
  readonly id: string;
  readonly label: string;
  readonly kind: QuotaWindow["kind"];
  readonly source: WindowSource;
  readonly cycleSeconds: number;
  readonly startsAt: DateTime.Utc;
  readonly resetsAt: DateTime.Utc;
  readonly usedPoints: number;
  readonly leftPoints: number;
  readonly pace: NonNullable<QuotaWindow["pace"]>["status"];
  readonly elapsedFraction: number;
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

export type { HeadlessFolder, PanePresence } from "./session-pane-presence";

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

export interface SessionQuotaInputs extends PresenceFields {
  readonly quota: QuotaRead;
  readonly savedProfiles: Reading<SavedProfiles>;
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

interface PacedWindow<W extends QuotaWindow = SourcedWindow> {
  readonly window: W;
  readonly percentRemaining: number;
  readonly resetsAt: DateTime.Utc;
  readonly cycleSeconds: number;
}

// Only a metered window with a reset and a cycle has a start, and model and credit windows meter something other than the account.
const pacedWindow = <W extends QuotaWindow>(window: W): PacedWindow<W> | undefined => {
  const cycleSeconds = window.pace?.cycleSeconds;
  if (!("percentRemaining" in window) || window.resetsAt === undefined || cycleSeconds === undefined) return undefined;
  if (!trackedKinds.has(window.kind)) return undefined;
  return { window, percentRemaining: window.percentRemaining, resetsAt: window.resetsAt, cycleSeconds };
};

const startOf = (paced: PacedWindow<QuotaWindow>): number => DateTime.toEpochMillis(paced.resetsAt) - paced.cycleSeconds * 1000;

const liveEntries = (quota: QuotaRead, now: DateTime.Utc): ReadonlyArray<SourcedProvider> =>
  sourcedEntries(quota, now).flatMap((entry) => ("kind" in entry ? [] : [entry]));

const earliestStart = (entries: ReadonlyArray<SourcedProvider>, fallback: number): number =>
  Math.min(
    fallback,
    ...entries.flatMap((entry) => entry.windows.flatMap((window) => {
      const paced = pacedWindow(window);
      return paced === undefined ? [] : [startOf(paced)];
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
  paced: PacedWindow,
  calls: ReadonlyArray<CountedCall>,
  inputs: SessionQuotaInputs,
  sessionsById: ReadonlyMap<string, Session>,
  availability: ReadonlyArray<QuotaAvailability>,
): WindowView => {
  const now = DateTime.toEpochMillis(inputs.now);
  const start = startOf(paced);
  const resetsAt = DateTime.toEpochMillis(paced.resetsAt);
  // quota-axi can hand back a window that has already reset, and calls after its reset belong to the next cycle.
  const end = Math.min(now, resetsAt);
  const hourCutoff = now - hourMillis;
  const spanHours = rateSpanHours(start, resetsAt, now);
  const inWindow = calls.filter((call) => call.at >= start && call.at < resetsAt && call.at <= now);
  const usedPoints = 100 - paced.percentRemaining;
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
  const elapsedFraction = (end - start) / (paced.cycleSeconds * 1000);
  const pace = now < resetsAt ? (paced.window.pace?.status ?? "unknown") : "unknown";
  const aheadOfPace = pace === "ahead";
  const pastFirstTenth = elapsedFraction >= firstTenth;
  const sustainablePointsPerHour =
    now < resetsAt ? paced.percentRemaining / Math.max((resetsAt - now) / hourMillis, 1 / 60) : null;
  const verdict = paced.window.source.kind === "quota-axi" ? verdictBeforeReset(availability, paced.window.id, resetsAt) : null;
  const gate = spendGate(rows, aheadOfPace && pastFirstTenth, sustainablePointsPerHour, verdict);
  return {
    id: paced.window.id,
    label: paced.window.label,
    kind: paced.window.kind,
    source: paced.window.source,
    cycleSeconds: paced.cycleSeconds,
    startsAt: DateTime.makeUnsafe(start),
    resetsAt: paced.resetsAt,
    usedPoints,
    leftPoints: paced.percentRemaining,
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
    otherCycle: [],
  };
};

interface AccountContext {
  readonly inputs: SessionQuotaInputs;
  readonly sessionsById: ReadonlyMap<string, Session>;
  readonly activeClaude: string | null;
}

const accountView = (
  entry: SourcedEntry,
  joined: ReadonlyArray<{ readonly call: CountedCall; readonly join: AccountJoin }>,
  { inputs, sessionsById, activeClaude }: AccountContext,
): AccountView => {
  const joins = joined.reduce<ReadonlyArray<AccountJoin>>(
    (seen, { join }) => (seen.some((known) => sameJoin(known, join)) ? seen : [...seen, join]),
    [],
  );
  const head = {
    provider: entry.provider,
    accountKey: entry.accountKey,
    credentialKey: credentialKeyOf(entry),
    accountKeys: keysOf(entry),
    title: accountTitle(entry, activeClaude),
    joins,
  };
  if ("kind" in entry) return { ...head, body: failureOf(entry) };
  const calls = joined.map(({ call }) => call);
  const availability = entry.state.stale ? [] : entry.quotaSemantics?.effectiveAvailability ?? [];
  const windows = entry.windows.flatMap((window) => {
    const paced = pacedWindow(window);
    return paced === undefined ? [] : [windowView(paced, calls, inputs, sessionsById, availability)];
  });
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
  const activeClaude = inputs.savedProfiles.kind === "ok" ? inputs.savedProfiles.value.active_profile : null;
  const entries = sourcedEntries(inputs.quota, inputs.now);
  const context: AccountContext = {
    inputs,
    sessionsById: new Map(inputs.sessions.map((session) => [session.id, session])),
    activeClaude,
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

export interface SessionQuotaReadings {
  readonly quota: QuotaRead;
  readonly savedProfiles: Reading<SavedProfiles>;
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
    savedProfiles: readings.savedProfiles,
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
