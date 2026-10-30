import { DateTime, Schema } from "effect";
import type { Failed } from "../reading";
import { type Session, sessionLabel } from "../sessions/live";
import { priceRatios, type Tokens, tokenTotal } from "../sessions/tokens";
import type { Estimate } from "../views/estimate";
import type { ModelTokens } from "../views/session-models";
import type { AccountView, SessionQuotaView, SessionShare, WindowView } from "../views/session-quota";
import type { WindowSource } from "../views/window-sources";

const Count = Schema.Finite;

const TokensJson = Schema.Struct({
  input: Count,
  output: Count,
  cacheRead: Count,
  cacheWrite: Count,
  total: Count,
});

const EstimateJson = Schema.Struct({ share: Count, contributionPoints: Count, pointsPerHour: Count });

export const SourceStatus = Schema.Struct({
  status: Schema.Literals(["ok", "unreachable", "invalid"]),
  detail: Schema.optionalKey(Schema.String),
});

export const SessionJson = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["pane", "process", "ended"]),
  live: Schema.Boolean,
  pane: Schema.optionalKey(Schema.String),
  paneStatus: Schema.optionalKey(Schema.String),
  pid: Schema.optionalKey(Count),
  harness: Schema.Literals(["pi", "claude-code", "codex"]),
  cwd: Schema.NullOr(Schema.String),
  place: Schema.String,
  label: Schema.String,
  files: Schema.Array(Schema.String),
  modelsSinceMidnight: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        model: Schema.NullOr(Schema.String),
        tokens: TokensJson,
        provider: Schema.optionalKey(Schema.NullOr(Schema.Literals(["claude", "codex", "opencode-go"]))),
      }),
    ),
  ),
});

export const UnmatchedRunsJson = Schema.Struct({
  harness: Schema.Literals(["pi", "claude-code", "codex"]),
  cwd: Schema.String,
  place: Schema.String,
  pids: Schema.Array(Count),
});

const PanePresenceJson = Schema.Struct({
  pane: Schema.String,
  paneStatus: Schema.optionalKey(Schema.String),
  tie: Schema.optionalKey(Schema.String),
});

const HeadlessFolderJson = Schema.Struct({
  cwd: Schema.String,
});

export const AccountRef = Schema.Struct({
  provider: Schema.Literals(["claude", "codex", "opencode-go"]),
  accountKey: Schema.NullOr(Schema.String),
  credentialKey: Schema.optionalKey(Schema.NullOr(Schema.String)),
  title: Schema.String,
});

const Join = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("credential-key"), key: Schema.String }),
  Schema.Struct({ kind: Schema.Literals(["only-account", "default-account"]) }),
]);

const HarvestedFields = { kind: Schema.Literal("harvested"), observedAt: Schema.String, file: Schema.String, join: Join };

// A report with no via predates the capture ledger, when every harvested reading came from a log.
const WindowSourceJson = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("quota-axi"), readAt: Schema.String }),
  Schema.Struct({ ...HarvestedFields, harness: Schema.Literal("codex"), via: Schema.optionalKey(Schema.Literal("log")) }),
  Schema.Struct({
    ...HarvestedFields,
    harness: Schema.Literal("claude-code"),
    via: Schema.optionalKey(Schema.Literals(["log", "statusline", "headless"])),
  }),
]);

export const AccountJson = Schema.Struct({
  ...AccountRef.fields,
  accountKeys: Schema.optionalKey(Schema.Array(Schema.String)),
  joins: Schema.Array(Join),
  quota: SourceStatus,
});

const ModelJson = Schema.Struct({
  model: Schema.NullOr(Schema.String),
  calls: Count,
  tokens: TokensJson,
  trailingHourTokens: TokensJson,
  priced: EstimateJson,
});

// A report with no models predates them, and every row it holds still reads.
export const WindowSessionJson = Schema.Struct({
  session: Schema.String,
  label: Schema.String,
  calls: Count,
  tokens: TokensJson,
  trailingHourTokens: TokensJson,
  raw: EstimateJson,
  priced: EstimateJson,
  models: Schema.optionalKey(Schema.Array(ModelJson)),
  flagged: Schema.Boolean,
});

export const WindowJson = Schema.Struct({
  account: AccountRef,
  id: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(["session", "weekly", "monthly", "model", "credits", "unknown"]),
  source: Schema.optionalKey(WindowSourceJson),
  startsAt: Schema.String,
  resetsAt: Schema.String,
  usedPoints: Count,
  leftPoints: Count,
  pace: Schema.Literals(["ahead", "on_pace", "behind", "unknown"]),
  elapsedFraction: Count,
  gate: Schema.Struct({ aheadOfPace: Schema.Boolean, pastFirstTenth: Schema.Boolean, open: Schema.Boolean }),
  exhaustsBeforeReset: Schema.optionalKey(Schema.Boolean),
  verdict: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  sustainablePointsPerHour: Schema.NullOr(Count),
  activeSessions: Count,
  fairPointsPerHour: Schema.NullOr(Count),
  observed: Schema.Struct({ calls: Count, tokens: TokensJson }),
  unattributedPoints: Count,
  sessions: Schema.Array(WindowSessionJson),
});

export const FlagJson = Schema.Struct({
  session: Schema.String,
  label: Schema.String,
  account: AccountRef,
  window: Schema.String,
  windowLabel: Schema.String,
  pricedPointsPerHour: Count,
  fairPointsPerHour: Count,
  pricedShare: Count,
  rawShare: Count,
});

export const PriceRatiosJson = Schema.Struct({ input: Count, output: Count, cacheRead: Count, cacheWrite: Count });

export const SourcesJson = Schema.Struct({ quota: SourceStatus, herdr: SourceStatus, processes: SourceStatus });

export const LedgerJson = Schema.Struct({
  bridgeCopiesDropped: Count,
  repeatedLinesDropped: Count,
  emptyRowsDropped: Count,
  forkCopiesDropped: Count,
  repeatedCountsDropped: Count,
  unjoinedCalls: Count,
});

export const UnmeteredJson = Schema.Struct({ route: Schema.String, calls: Count, tokens: TokensJson });

export const SessionQuotaReport = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  generatedAt: Schema.String,
  panePresence: Schema.optionalKey(Schema.Array(PanePresenceJson)),
  headlessFolders: Schema.optionalKey(Schema.Array(HeadlessFolderJson)),
  scope: Schema.Literal("local"),
  estimate: Schema.Struct({
    basis: Schema.Literal("local-logs"),
    upperBound: Schema.Literal(true),
    priceRatios: PriceRatiosJson,
  }),
  sources: SourcesJson,
  ledger: LedgerJson,
  accounts: Schema.Array(AccountJson),
  windows: Schema.Array(WindowJson),
  sessions: Schema.Array(SessionJson),
  unmatchedProcesses: Schema.Array(UnmatchedRunsJson),
  flags: Schema.Array(FlagJson),
  unmetered: Schema.Array(UnmeteredJson),
});

export type SessionQuotaReport = typeof SessionQuotaReport.Type;

export type SessionQuotaFlag = typeof FlagJson.Type;

export const SessionQuotaAlert = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  event: Schema.Literals(["flagged", "cleared"]),
  at: Schema.String,
  flag: FlagJson,
});

export type SessionQuotaAlert = typeof SessionQuotaAlert.Type;

export const instant = (value: DateTime.Utc): string => DateTime.formatIso(value);

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

// quota-axi names an account's row differently once the provider has more than one, so an edge follows the account's own credential.
const flagKey = (flag: SessionQuotaFlag): string =>
  `${flag.session} ${flag.account.provider} ${flag.account.credentialKey ?? ""} ${flag.window}`;

// The stream carries edges only, so a supervisor tailing it wakes once when a flag rises and once when it clears.
export const sessionQuotaAlerts = (
  before: ReadonlyArray<SessionQuotaFlag>,
  after: ReadonlyArray<SessionQuotaFlag>,
  at: DateTime.Utc,
): ReadonlyArray<SessionQuotaAlert> => {
  const earlier = new Set(before.map(flagKey));
  const later = new Set(after.map(flagKey));
  const event = (kind: SessionQuotaAlert["event"]) => (flag: SessionQuotaFlag): SessionQuotaAlert => ({
    schemaVersion: 1,
    event: kind,
    at: instant(at),
    flag,
  });
  return [
    ...after.filter((flag) => !earlier.has(flagKey(flag))).map(event("flagged")),
    ...before.filter((flag) => !later.has(flagKey(flag))).map(event("cleared")),
  ];
};
