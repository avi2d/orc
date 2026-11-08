import { DateTime, Schema } from "effect";

const Count = Schema.Finite;

export const TokensJson = Schema.Struct({
  input: Count,
  output: Count,
  cacheRead: Count,
  cacheWrite: Count,
  total: Count,
});

export const EstimateJson = Schema.Struct({ share: Count, contributionPoints: Count, pointsPerHour: Count });

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

export const PanePresenceJson = Schema.Struct({
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
export const WindowSourceJson = Schema.Union([
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
