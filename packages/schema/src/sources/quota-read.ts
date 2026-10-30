import { DateTime, Effect } from "effect";
import { failureOf, type Reading } from "../reading";
import type { AccountCaptured } from "../sessions/capture";
import { type HarvestedReading, harvestedReadings } from "../sessions/harvest";
import { type AccountJoin, nativeKeys } from "../views/account-join";
import {
  harvestedWindow,
  joinedReadings,
  type SourcedEntry,
  type SourcedProvider,
  sourcedProvider,
  type WindowShape,
  type WindowSource,
} from "../views/window-sources";
import { type FailedQuotaEntry, type QuotaProviderId, type QuotaReport, QuotaSource, shownQuotaProviders } from "./quota";
import { HarvestLogSource } from "./session-logs";

// A configured account's own reading, which never joins another account or stands in for quota-axi's.
export interface AccountRead {
  readonly name: string;
  readonly read: SourcedProvider | undefined;
}

export interface QuotaRead {
  readonly quotaAxi: Reading<QuotaReport>;
  readonly logAccounts: ReadonlyArray<SourcedProvider>;
  readonly logReadings: ReadonlyArray<HarvestedReading>;
  readonly accounts: ReadonlyArray<AccountRead>;
}

type LoggedProvider = HarvestedReading["provider"];

const loggedProviders = ["claude", "codex"] as const satisfies ReadonlyArray<LoggedProvider>;

// quota-axi's ids, labels and kinds for the account windows each harness logs, so a log account reads as quota-axi's would.
const accountWindows = {
  claude: [
    { id: "five_hour", label: "session", kind: "session" },
    { id: "seven_day", label: "week", kind: "weekly" },
  ],
  codex: [
    { id: "five_hour", label: "session", kind: "session" },
    { id: "weekly", label: "week", kind: "weekly" },
  ],
} as const satisfies Record<LoggedProvider, ReadonlyArray<WindowShape>>;

// quota-axi reuses a reading only while it is younger than its --max-age, at most an hour, so a log reading that old asks quota-axi again.
export const logFreshMillis = 3_600_000;

export type SavedAge =
  | { readonly kind: "dated"; readonly fetchedAt: DateTime.Utc; readonly ageSeconds: number }
  | { readonly kind: "undated" };

export const staleSourceAgeSeconds = (source: WindowSource, now: DateTime.Utc): number | undefined => {
  const readAt = source.kind === "quota-axi" ? source.readAt : source.observedAt;
  const ageMillis = DateTime.toEpochMillis(now) - DateTime.toEpochMillis(readAt);
  return ageMillis >= logFreshMillis ? Math.floor(ageMillis / 1000) : undefined;
};

export const savedAgeSeconds = (fetchedAt: DateTime.Utc, now: DateTime.Utc): number =>
  Math.max(0, Math.floor((DateTime.toEpochMillis(now) - DateTime.toEpochMillis(fetchedAt)) / 1000));

// Saved profiles reuse quota-axi's bound on reuse: a profile read more than an hour ago reads stale.
export const staleSavedAgeSeconds = (age: SavedAge, stale: boolean, now: DateTime.Utc): number | undefined => {
  if (age.kind !== "dated") return undefined;
  return stale || DateTime.toEpochMillis(now) - DateTime.toEpochMillis(age.fetchedAt) >= logFreshMillis
    ? savedAgeSeconds(age.fetchedAt, now)
    : undefined;
};

interface Covered {
  readonly shape: WindowShape;
  readonly reading: HarvestedReading;
}

const freshReading = (
  readings: ReadonlyArray<HarvestedReading>,
  provider: LoggedProvider,
  windowId: string,
  now: number,
): HarvestedReading | undefined =>
  readings.find(
    (reading) =>
      reading.provider === provider &&
      reading.windowId === windowId &&
      reading.resetsAt > now &&
      now - reading.observedAt < logFreshMillis,
  );

const coveredWindows = (provider: LoggedProvider, readings: ReadonlyArray<HarvestedReading>, now: number): ReadonlyArray<Covered> =>
  accountWindows[provider].flatMap((shape): ReadonlyArray<Covered> => {
    const reading = freshReading(readings, provider, shape.id, now);
    return reading === undefined ? [] : [{ shape, reading }];
  });

const harvestedAccount = (
  provider: LoggedProvider,
  key: string,
  covered: ReadonlyArray<Covered>,
  join: AccountJoin,
  now: DateTime.Utc,
): SourcedProvider => ({
  provider,
  accountKeys: [key],
  reportedAt: now,
  state: { status: "fresh", stale: false },
  windows: covered.map(({ shape, reading }) => harvestedWindow(shape, reading, join, DateTime.toEpochMillis(now))),
});

// A log names at most the credential it ran under, so a log account stands for that key, or else for the provider's only login.
const logAccount = (
  provider: LoggedProvider,
  readings: ReadonlyArray<HarvestedReading>,
  now: DateTime.Utc,
): SourcedProvider | undefined => {
  const covered = coveredWindows(provider, readings, DateTime.toEpochMillis(now));
  if (covered.length < accountWindows[provider].length) return undefined;
  const key = covered.at(0)?.reading.credentialKey;
  const join: AccountJoin = key === undefined ? { kind: "only-account" } : { kind: "credential-key", key };
  return harvestedAccount(provider, key ?? nativeKeys[provider], covered, join, now);
};

// A log account needs every window because it stands in for quota-axi, and an account stands in for nothing, so it shows what was read.
const accountRead = (account: AccountCaptured, now: DateTime.Utc): AccountRead => {
  const covered = coveredWindows("claude", harvestedReadings([], account.readings), DateTime.toEpochMillis(now));
  return {
    name: account.name,
    read:
      covered.length === 0
        ? undefined
        : harvestedAccount("claude", account.name, covered, { kind: "credential-key", key: account.name }, now),
  };
};

interface QuotaChoice {
  readonly asked: ReadonlyArray<QuotaProviderId>;
  readonly logAccounts: ReadonlyArray<SourcedProvider>;
}

// quota-axi is the fallback: a provider whose every account window the logs read within the bound is not asked, and OpenCode Go never logs one.
const quotaChoice = (readings: ReadonlyArray<HarvestedReading>, now: DateTime.Utc): QuotaChoice => {
  const logAccounts = loggedProviders.flatMap((provider) => {
    const account = logAccount(provider, readings, now);
    return account === undefined ? [] : [account];
  });
  return { asked: askedOf(logAccounts), logAccounts };
};

const askedOf = (logAccounts: ReadonlyArray<SourcedProvider>): ReadonlyArray<QuotaProviderId> =>
  shownQuotaProviders.filter((provider) => !logAccounts.some((account) => account.provider === provider));

export const readQuota: Effect.Effect<QuotaRead, never, QuotaSource | HarvestLogSource> = Effect.gen(function* () {
  const logs = yield* HarvestLogSource;
  const quota = yield* QuotaSource;
  const now = yield* DateTime.now;
  const since = DateTime.toEpochMillis(now) - logFreshMillis;
  const read = yield* logs.read({ "claude-code": since, codex: since });
  const logReadings = harvestedReadings(read.files, read.captured.readings);
  const choice = quotaChoice(logReadings, now);
  const quotaAxi = yield* quota.read(choice.asked);
  const accounts = read.captured.accounts.map((account) => accountRead(account, now));
  return { quotaAxi, logAccounts: choice.logAccounts, logReadings, accounts };
});

const providerRank = (entry: SourcedEntry): number => shownQuotaProviders.indexOf(entry.provider);

// A failed quota-axi read fails only the providers it was asked about, so the logs' accounts stand beside the failure.
const reportedEntries = (read: QuotaRead, now: DateTime.Utc): ReadonlyArray<SourcedEntry> => {
  const quota = read.quotaAxi;
  if (quota.kind !== "ok") {
    return askedOf(read.logAccounts).map((provider): FailedQuotaEntry => ({ provider, accountKey: undefined, ...failureOf(quota) }));
  }
  const readings = joinedReadings(read.logReadings, quota.value.providers);
  return quota.value.providers.map(
    (entry): SourcedEntry => ("kind" in entry ? entry : sourcedProvider(entry, quota.value.generatedAt, readings, now)),
  );
};

export const sourcedEntries = (read: QuotaRead, now: DateTime.Utc): ReadonlyArray<SourcedEntry> =>
  [...reportedEntries(read, now), ...read.logAccounts].toSorted((left, right) => providerRank(left) - providerRank(right));
