import { DateTime, Result, Schema } from "effect";
import type { QuotaProvider, QuotaProviderId, QuotaReport, QuotaWindow } from "./quota";
import type { DashConfig } from "../../../shared/config";

const Instant = Schema.DateTimeUtcFromString;
const Label = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/u));
const FailureCode = Schema.Literals(["timeout", "rate_limited", "auth_required", "auth_unverified"]);
const Window = Schema.Struct({
  id: Label,
  scope: Label,
  percentLeft: Schema.NullOr(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  resetsAt: Schema.NullOr(Instant),
});
const Windows = Schema.NonEmptyArray(Window).check(
  Schema.makeFilter((windows) => new Set(windows.map((window) => window.id)).size === windows.length),
);
const Observation = Schema.Union([
  Schema.Struct({ status: Schema.Literal("fresh"), observedAt: Instant, validUntil: Instant, source: Schema.Literal("provider"), windows: Windows }).check(
    Schema.makeFilter(({ observedAt, validUntil, windows }) =>
      DateTime.toEpochMillis(validUntil) === windows.reduce(
        (end, window) => window.resetsAt === null ? end : Math.min(end, DateTime.toEpochMillis(window.resetsAt)),
        DateTime.toEpochMillis(observedAt) + 120_000,
      ),
    ),
  ),
  Schema.Struct({ status: Schema.Literal("stale"), observedAt: Instant, source: Schema.Literal("provider"), windows: Windows, code: Schema.NullOr(FailureCode) }),
  Schema.Struct({ status: Schema.Literal("unavailable"), code: FailureCode }),
]);
const Snapshot = Schema.Struct({
  version: Schema.Literal("subquo.v1"),
  writtenAt: Instant,
  accounts: Schema.Array(Schema.Struct({
    id: Label,
    provider: Schema.Literals(["claude", "codex", "opencode-go"]),
    observation: Observation,
    loginEndsInDays: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 7 })))),
  })),
}).check(Schema.makeFilter(({ accounts, writtenAt }) => {
  if (new Set(accounts.map((account) => account.id)).size !== accounts.length) return false;
  const written = DateTime.toEpochMillis(writtenAt);
  return accounts.every(({ observation }) =>
    observation.status === "unavailable" ||
    (DateTime.toEpochMillis(observation.observedAt) <= written &&
      (observation.status === "stale" || written < DateTime.toEpochMillis(observation.validUntil))),
  );
}));

export type SubquoMapping = NonNullable<DashConfig["subquoAccounts"]>[number];

export type SubquoObservation = typeof Observation.Type;

export interface MatchedSubquo {
  readonly mapping: SubquoMapping;
  readonly observation: SubquoObservation;
}

export const matchSubquo = (snapshot: unknown, mappings: ReadonlyArray<SubquoMapping>): ReadonlyArray<MatchedSubquo> => {
  const decoded = Schema.decodeUnknownResult(Snapshot)(snapshot);
  if (Result.isFailure(decoded)) return [];
  const accounts = decoded.success.accounts;
  return mappings.flatMap((mapping) => {
    const entries = accounts.filter((account) => account.id === mapping.subquoId);
    const entry = entries.length === 1 ? entries[0] : undefined;
    const sameTarget = mappings.filter((other) => other.provider === mapping.provider && other.accountKey === mapping.accountKey);
    const sameSource = mappings.filter((other) => other.subquoId === mapping.subquoId);
    return entry?.provider === mapping.provider && sameTarget.length === 1 && sameSource.length === 1
      ? [{ mapping, observation: entry.observation }]
      : [];
  });
};

const quotaWindowId = (provider: QuotaProviderId, id: string, scope: string): string | undefined => {
  if (scope !== "all") return undefined;
  if (id === "five-hour") return provider === "opencode-go" ? "rolling" : "five_hour";
  if (id === "weekly") return provider === "claude" ? "seven_day" : "weekly";
  if (provider === "opencode-go" && (id === "rolling" || id === "monthly")) return id;
  return undefined;
};

const freshAt = (observation: SubquoObservation, now: DateTime.Utc): observation is Extract<SubquoObservation, { readonly status: "fresh" }> =>
  observation.status === "fresh" &&
  DateTime.toEpochMillis(observation.observedAt) <= DateTime.toEpochMillis(now) &&
  DateTime.toEpochMillis(now) < DateTime.toEpochMillis(observation.validUntil);

const overlayProvider = (
  entry: QuotaProvider,
  match: MatchedSubquo,
  now: DateTime.Utc,
): QuotaProvider => {
  const observation = match.observation;
  if (!freshAt(observation, now)) return entry;
  let changed = false;
  const windows = entry.windows.map((window): QuotaWindow => {
    if (!("percentRemaining" in window)) return window;
    const found = observation.windows.filter((item) =>
      quotaWindowId(entry.provider, item.id, item.scope) === window.id &&
      (entry.provider !== "opencode-go" || item.id !== "five-hour" || window.windowSeconds === 18_000),
    );
    const reading = found.length === 1 ? found[0] : undefined;
    if (reading === undefined || reading.percentLeft === null || reading.resetsAt === null) return window;
    changed = true;
    const { pace: _pace, ...rest } = window;
    return { ...rest, percentRemaining: reading.percentLeft, resetsAt: reading.resetsAt, subquoReadAt: observation.observedAt };
  });
  if (!changed) return entry;
  const { quotaSemantics: _quotaSemantics, ...rest } = entry;
  return { ...rest, windows };
};

export const standaloneSubquo = (
  snapshot: unknown,
  mappings: ReadonlyArray<SubquoMapping>,
  now: DateTime.Utc,
): ReadonlyArray<QuotaProvider> => matchSubquo(snapshot, mappings).flatMap(({ mapping, observation }) => {
  if (!freshAt(observation, now)) return [];
  const windows = observation.windows.flatMap((window): ReadonlyArray<QuotaWindow> => {
    const id = quotaWindowId(mapping.provider, window.id, window.scope);
    if (id === undefined || window.percentLeft === null || window.resetsAt === null) return [];
    const shape = id === "five_hour"
      ? { label: "session", kind: "session" as const, windowSeconds: 18_000 }
      : id === "rolling" && window.id === "five-hour"
        ? { label: "rolling", kind: "unknown" as const, windowSeconds: 18_000 }
      : id === "seven_day" || id === "weekly"
        ? { label: "week", kind: "weekly" as const, windowSeconds: 604_800 }
        : id === "monthly"
          ? { label: "month", kind: "monthly" as const }
          : { label: "rolling", kind: "unknown" as const };
    return [{
      id,
      ...shape,
      percentRemaining: window.percentLeft,
      resetsAt: window.resetsAt,
      subquoReadAt: observation.observedAt,
    }];
  });
  if (windows.length === 0) return [];
  return [{
    provider: mapping.provider,
    accountKey: mapping.accountKey,
    accountKeys: [mapping.accountKey],
    windows,
    state: { status: "fresh", stale: false, refreshedAt: observation.observedAt },
  }];
});

export const overlaySubquo = (
  report: QuotaReport,
  snapshot: unknown,
  mappings: ReadonlyArray<SubquoMapping>,
  now: DateTime.Utc,
): QuotaReport => {
  const matches = matchSubquo(snapshot, mappings);
  const providers = report.providers.map((entry) => {
    if ("kind" in entry) return entry;
    const keys = entry.accountKeys ?? (entry.accountKey === undefined ? [] : [entry.accountKey]);
    const own = matches.filter(({ mapping }) => mapping.provider === entry.provider && keys.includes(mapping.accountKey));
    const match = own.length === 1 ? own[0] : undefined;
    return match === undefined ? entry : overlayProvider(entry, match, now);
  });
  const additional = standaloneSubquo(snapshot, mappings, now).filter((account) =>
    !providers.some((entry) =>
      !("kind" in entry) && entry.provider === account.provider &&
      (entry.accountKeys ?? (entry.accountKey === undefined ? [] : [entry.accountKey])).includes(account.accountKey ?? ""),
    ),
  );
  return {
    ...report,
    providers: [...providers, ...additional],
    notSetUp: report.notSetUp.filter((provider) => !additional.some((account) => account.provider === provider)),
  };
};
