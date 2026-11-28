import { DateTime, Duration, Effect, Layer, Result, Schema } from "effect";
import { type QuotaProvider, type QuotaProviderId, type QuotaReport, QuotaSource, type QuotaWindow, readQuotaAxi } from "./quota";
import type { DashConfig } from "../../../shared/config";
import { CommandRunner, decodeJson, failureOf, runDecoded } from "../../../shared/lib";
import { linearPace } from "./window-sources";

const Instant = Schema.DateTimeUtcFromString;
const Label = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/u));
const FailureCode = Schema.Literals(["timeout", "rate_limited", "auth_required", "auth_unverified"]);
const Window = Schema.Union([
  Schema.Struct({ id: Label, scope: Schema.optionalKey(Label), percentLeft: Schema.Null, resetsAt: Schema.Null, status: Schema.Literal("not_returned") }),
  Schema.Struct({
    id: Label,
    scope: Label,
    percentLeft: Schema.NullOr(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
    resetsAt: Schema.NullOr(Instant),
    status: Schema.optionalKey(Schema.String),
  }),
]);
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

type SubquoObservation = typeof Observation.Type;

interface MatchedSubquo {
  readonly mapping: SubquoMapping;
  readonly observation: SubquoObservation;
}

const matchSubquo = (snapshot: unknown, mappings: ReadonlyArray<SubquoMapping>): ReadonlyArray<MatchedSubquo> => {
  const decoded = Schema.decodeUnknownResult(Snapshot)(snapshot);
  if (Result.isFailure(decoded)) return [];
  const accounts = decoded.success.accounts;
  return mappings.flatMap((mapping) => {
    const entry = accounts.find((account) => account.id === mapping.subquoId);
    return entry?.provider === mapping.provider ? [{ mapping, observation: entry.observation }] : [];
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

// quota-axi's pace rests on its own reading, so a subquo reading paces itself on the window's cycle.
const paceOf = (cycleSeconds: number | undefined, percentLeft: number, resetsAt: DateTime.Utc, now: DateTime.Utc) =>
  cycleSeconds === undefined
    ? {}
    : { pace: linearPace(cycleSeconds, percentLeft, DateTime.toEpochMillis(resetsAt), DateTime.toEpochMillis(now)) };

interface WindowShape {
  readonly label: string;
  readonly kind: QuotaWindow["kind"];
  readonly windowSeconds?: number;
}

const windowShape = (id: string, subquoId: string): WindowShape => {
  if (id === "five_hour") return { label: "session", kind: "session", windowSeconds: 18_000 };
  if (id === "rolling" && subquoId === "five-hour") return { label: "rolling", kind: "unknown", windowSeconds: 18_000 };
  if (id === "seven_day" || id === "weekly") return { label: "week", kind: "weekly", windowSeconds: 604_800 };
  if (id === "monthly") return { label: "month", kind: "monthly" };
  return { label: "rolling", kind: "unknown" };
};

const overlayProvider = (
  entry: QuotaProvider,
  match: MatchedSubquo,
  now: DateTime.Utc,
): QuotaProvider => {
  const observation = match.observation;
  if (!freshAt(observation, now)) return entry;
  const returned = observation.windows.filter((window) => window.status !== "not_returned");
  const notReturned = observation.windows.filter((window) => window.status === "not_returned");
  const windows = entry.windows.filter((window) => !notReturned.some((item) =>
    quotaWindowId(entry.provider, item.id, item.scope ?? "all") === window.id &&
    (entry.provider !== "opencode-go" || item.id !== "five-hour" || window.windowSeconds === 18_000),
  )).map((window): QuotaWindow => {
    if (!("percentRemaining" in window)) return window;
    const found = returned.filter((item) =>
      quotaWindowId(entry.provider, item.id, item.scope ?? "all") === window.id &&
      (entry.provider !== "opencode-go" || item.id !== "five-hour" || window.windowSeconds === 18_000),
    );
    const reading = found.length === 1 ? found[0] : undefined;
    if (reading === undefined || reading.percentLeft === null || reading.resetsAt === null) return window;
    const { pace, ...rest } = window;
    return {
      ...rest,
      ...paceOf(pace?.cycleSeconds ?? window.windowSeconds, reading.percentLeft, reading.resetsAt, now),
      percentRemaining: reading.percentLeft,
      resetsAt: reading.resetsAt,
      subquoReadAt: observation.observedAt,
    };
  });
  return { ...entry, windows };
};

const standaloneSubquo = (
  snapshot: unknown,
  mappings: ReadonlyArray<SubquoMapping>,
  now: DateTime.Utc,
): ReadonlyArray<QuotaProvider> => matchSubquo(snapshot, mappings).flatMap(({ mapping, observation }) => {
  if (!freshAt(observation, now)) return [];
  const windows = observation.windows.flatMap((window): ReadonlyArray<QuotaWindow> => {
    if (window.status === "not_returned") return [];
    const id = quotaWindowId(mapping.provider, window.id, window.scope ?? "all");
    if (id === undefined || window.percentLeft === null || window.resetsAt === null) return [];
    const shape = windowShape(id, window.id);
    return [{
      id,
      ...shape,
      ...paceOf(shape.windowSeconds, window.percentLeft, window.resetsAt, now),
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
    const match = matches.find(({ mapping }) => mapping.provider === entry.provider && keys.includes(mapping.accountKey));
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

export const quotaSourceLayerWithMappings = <E, R>(
  mappings: Effect.Effect<ReadonlyArray<SubquoMapping>, E, R>,
): Layer.Layer<QuotaSource, E, CommandRunner | R> => Layer.effect(
  QuotaSource,
  Effect.gen(function* () {
    const runner = yield* CommandRunner;
    const configured = yield* mappings;
    return {
      read: (providers: ReadonlyArray<QuotaProviderId>) => Effect.gen(function* () {
        const quota = Effect.provideService(readQuotaAxi(providers), CommandRunner, runner);
        const relevant = configured.filter((mapping) => providers.includes(mapping.provider));
        if (relevant.length === 0) return yield* quota;
        const subquo = Effect.provideService(
          runDecoded({ argv: ["subquo", "read", "--json"], timeout: Duration.seconds(15) }, decodeJson(Schema.Unknown)),
          CommandRunner,
          runner,
        );
        const [report, snapshot] = yield* Effect.all([quota, subquo], { concurrency: "unbounded" });
        if (snapshot.kind !== "ok") return report;
        const now = yield* DateTime.now;
        if (report.kind === "ok") return { ...report, value: overlaySubquo(report.value, snapshot.value, relevant, now) };
        const found = standaloneSubquo(snapshot.value, relevant, now);
        if (found.length === 0) return report;
        return {
          kind: "ok" as const,
          capturedAt: report.capturedAt,
          value: {
            generatedAt: now,
            providers: [...found, ...providers.map((provider) => ({ provider, accountKey: undefined, ...failureOf(report) }))],
            notSetUp: [],
          },
        };
      }),
    };
  }),
);
