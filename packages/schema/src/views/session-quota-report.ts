import type { Failed } from "../reading";
import { priceRatios, type Tokens, tokenTotal } from "../contract/tokens";
import { type Session, sessionLabel } from "../sources/live";
import {
  AccountJson,
  AccountRef,
  instant,
  PanePresenceJson,
  EstimateJson,
  SessionJson,
  SessionQuotaFlag,
  SessionQuotaReport,
  SourceStatus,
  TokensJson,
  UnmeteredJson,
  WindowJson,
  WindowSessionJson,
  WindowSourceJson,
} from "../contract/session-quota";
import type { WindowSource } from "../sources/window-sources";
import type { Estimate } from "./estimate";
import type { ModelTokens } from "./session-models";
import type { AccountView, SessionQuotaView, SessionShare, WindowView } from "./session-quota";

const tokensJson = (tokens: Tokens): typeof TokensJson.Type => ({ ...tokens, total: tokenTotal(tokens) });

const estimateJson = (estimate: Estimate): typeof EstimateJson.Type => ({ ...estimate });

export const statusOf = (failure: Failed | undefined): typeof SourceStatus.Type => {
  if (failure === undefined) return { status: "ok" };
  return failure.kind === "unreachable"
    ? { status: "unreachable", detail: failure.reason }
    : { status: "invalid", detail: failure.issue };
};

export const sessionJson = (session: Session, models: ReadonlyArray<ModelTokens>): typeof SessionJson.Type => {
  const identity = session.identity;
  return {
    id: session.id,
    kind: identity.kind,
    live: identity.kind !== "ended",
    ...(identity.kind === "pane"
      ? { pane: identity.pane, ...(identity.status === undefined ? {} : { paneStatus: identity.status }) }
      : {}),
    ...(identity.kind === "process" ? { pid: identity.pid } : {}),
    harness: session.harness,
    cwd: session.cwd ?? null,
    place: session.place,
    label: sessionLabel(session),
    files: session.files,
    modelsSinceMidnight: models.map((model) => ({
      model: model.model ?? null,
      tokens: tokensJson(model.tokens),
      ...(model.provider === undefined ? {} : { provider: model.provider }),
    })),
  };
};

export const modelsSinceMidnightOf = (view: SessionQuotaView, session: Session): ReadonlyArray<ModelTokens> =>
  view.modelsSinceMidnight.find((entry) => entry.session === session)?.models ?? [];

export const accountRef = (account: Pick<AccountView, "provider" | "accountKey" | "credentialKey" | "title">): typeof AccountRef.Type => ({
  provider: account.provider,
  accountKey: account.accountKey ?? null,
  credentialKey: account.credentialKey ?? null,
  title: account.title,
});

export const windowSessionJson = (row: SessionShare): typeof WindowSessionJson.Type => ({
  session: row.session.id,
  label: row.label,
  calls: row.calls,
  tokens: tokensJson(row.tokens),
  trailingHourTokens: tokensJson(row.trailingHourTokens),
  raw: estimateJson(row.raw),
  priced: estimateJson(row.priced),
  models: row.models.map((model) => ({
    model: model.model ?? null,
    calls: model.calls,
    tokens: tokensJson(model.tokens),
    trailingHourTokens: tokensJson(model.trailingHourTokens),
    priced: estimateJson(model.priced),
  })),
  flagged: row.flagged,
});

const sourceJson = (source: WindowSource): typeof WindowSourceJson.Type =>
  source.kind === "quota-axi"
    ? { kind: "quota-axi", readAt: instant(source.readAt) }
    : { ...source, observedAt: instant(source.observedAt) };

export const windowJson = (account: AccountView, window: WindowView): typeof WindowJson.Type => ({
  account: accountRef(account),
  id: window.id,
  label: window.label,
  kind: window.kind,
  source: sourceJson(window.source),
  startsAt: instant(window.startsAt),
  resetsAt: instant(window.resetsAt),
  usedPoints: window.usedPoints,
  leftPoints: window.leftPoints,
  pace: window.pace,
  elapsedFraction: window.elapsedFraction,
  gate: {
    aheadOfPace: window.aheadOfPace,
    pastFirstTenth: window.pastFirstTenth,
    open: window.aheadOfPace && window.pastFirstTenth,
  },
  exhaustsBeforeReset: window.exhaustsBeforeReset,
  verdict: window.verdict,
  sustainablePointsPerHour: window.sustainablePointsPerHour,
  activeSessions: window.activeSessions,
  fairPointsPerHour: window.fairPointsPerHour,
  observed: { calls: window.observedCalls, tokens: tokensJson(window.observedTokens) },
  unattributedPoints: window.unattributedPoints,
  sessions: window.sessions.map(windowSessionJson),
});

export const windowsOf = (account: AccountView): ReadonlyArray<WindowView> =>
  account.body.kind === "windows" ? account.body.windows : [];

export interface FlaggedRow {
  readonly session: Session;
  readonly flag: SessionQuotaFlag;
}

export const flaggedRows = (view: SessionQuotaView): ReadonlyArray<FlaggedRow> =>
  view.accounts.flatMap((account) =>
    windowsOf(account).flatMap(({ fairPointsPerHour, ...window }) =>
      // A window past its reset has an unknown pace, so its gate is shut and it holds no flag.
      fairPointsPerHour === null
        ? []
        : window.sessions
            .filter((row) => row.flagged)
            .map((row) => ({
              session: row.session,
              flag: {
                session: row.session.id,
                label: row.label,
                account: accountRef(account),
                window: window.id,
                windowLabel: window.label,
                pricedPointsPerHour: row.priced.pointsPerHour,
                fairPointsPerHour,
                pricedShare: row.priced.share,
                rawShare: row.raw.share,
              },
            })),
    ),
  );

export const sessionQuotaFlags = (view: SessionQuotaView): ReadonlyArray<SessionQuotaFlag> =>
  flaggedRows(view).map(({ flag }) => flag);

export const accountJson = (account: AccountView): typeof AccountJson.Type => ({
  ...accountRef(account),
  accountKeys: account.accountKeys,
  joins: account.joins,
  quota: statusOf(account.body.kind === "windows" ? undefined : account.body),
});

export const unmeteredJson = (entry: SessionQuotaView["unmetered"][number]): typeof UnmeteredJson.Type => ({
  ...entry,
  tokens: tokensJson(entry.tokens),
});

const panePresenceJson = (pane: NonNullable<SessionQuotaView["panePresence"]>[number]): typeof PanePresenceJson.Type => ({
  pane: pane.pane,
  ...(pane.status === undefined ? {} : { paneStatus: pane.status }),
  ...(pane.tie === undefined ? {} : { tie: pane.tie }),
});

export const sessionQuotaReport = (view: SessionQuotaView): SessionQuotaReport => ({
  schemaVersion: 1,
  generatedAt: instant(view.now),
  panePresence: (view.panePresence ?? []).map(panePresenceJson),
  headlessFolders: (view.headlessFolders ?? []).map(({ cwd }) => ({ cwd })),
  scope: "local",
  estimate: { basis: "local-logs", upperBound: true, priceRatios: { ...priceRatios } },
  sources: { quota: statusOf(view.quota), herdr: statusOf(view.panes), processes: statusOf(view.processes) },
  ledger: { ...view.ledger, unjoinedCalls: view.unjoinedCalls },
  accounts: view.accounts.map(accountJson),
  windows: view.accounts.flatMap((account) => windowsOf(account).map((window) => windowJson(account, window))),
  sessions: view.sessions.map((session) => sessionJson(session, modelsSinceMidnightOf(view, session))),
  unmatchedProcesses: view.unmatched.map(({ machine: _, ...runs }) => ({ ...runs })),
  flags: sessionQuotaFlags(view),
  unmetered: view.unmetered.map(unmeteredJson),
});

