import { DateTime } from "effect";
import type { HarvestedReading, HarvestOrigin } from "../sessions/harvest";
import type { FailedQuotaEntry, QuotaProvider, QuotaProviderEntry, QuotaWindow } from "../sources/quota";
import { type AccountJoin, readingJoin } from "./account-join";

export type WindowSource =
  | { readonly kind: "quota-axi"; readonly readAt: DateTime.Utc }
  | (HarvestOrigin & {
      readonly kind: "harvested";
      readonly observedAt: DateTime.Utc;
      readonly file: string;
      readonly join: AccountJoin;
    });

export type SourcedWindow = QuotaWindow & { readonly source: WindowSource };

export type SourcedProvider = Omit<QuotaProvider, "windows"> & {
  readonly reportedAt: DateTime.Utc;
  readonly windows: ReadonlyArray<SourcedWindow>;
};

export type SourcedEntry = SourcedProvider | FailedQuotaEntry;

export interface JoinedReading {
  readonly reading: HarvestedReading;
  readonly entry: QuotaProviderEntry;
  readonly join: AccountJoin;
}

export const joinedReadings = (
  readings: ReadonlyArray<HarvestedReading>,
  entries: ReadonlyArray<QuotaProviderEntry>,
): ReadonlyArray<JoinedReading> =>
  readings.flatMap((reading) => {
    const joined = readingJoin({ provider: reading.provider, credentialKey: reading.credentialKey }, entries);
    return joined === undefined ? [] : [{ reading, ...joined }];
  });

type Pace = NonNullable<QuotaWindow["pace"]>;

export type WindowShape = Pick<QuotaWindow, "id" | "label" | "kind">;

// quota-axi's published deadband: a reserve within a point of zero reads on pace.
const onPaceDeadband = 1;

const linearPace = (cycleSeconds: number, percentRemaining: number, resetsAt: number, now: number): Pace => {
  const timeRemainingPercent = (100 * (resetsAt - now)) / (cycleSeconds * 1000);
  const reservePercentPoints = percentRemaining - timeRemainingPercent;
  const status =
    Math.abs(reservePercentPoints) <= onPaceDeadband ? "on_pace" : reservePercentPoints < 0 ? "ahead" : "behind";
  return { status, cycleSeconds, timeRemainingPercent, reservePercentPoints };
};

const originOf = (reading: HarvestedReading): HarvestOrigin =>
  reading.harness === "codex" ? { harness: "codex", via: "log" } : { harness: "claude-code", via: reading.via };

// quota-axi derives pace, projections and runway from its own reading, so a harvested window paces itself on its own cycle.
export const harvestedWindow = (shape: WindowShape, reading: HarvestedReading, join: AccountJoin, now: number): SourcedWindow => ({
  id: shape.id,
  label: shape.label,
  kind: shape.kind,
  percentRemaining: reading.percentRemaining,
  resetsAt: DateTime.makeUnsafe(reading.resetsAt),
  pace: linearPace(reading.cycleSeconds, reading.percentRemaining, reading.resetsAt, now),
  source: {
    kind: "harvested",
    ...originOf(reading),
    observedAt: DateTime.makeUnsafe(reading.observedAt),
    file: reading.file,
    join,
  },
});

// A harvested reading is only as fresh as the last call on its account, so it replaces quota-axi's only when it is newer and its cycle is still open.
export const sourcedProvider = (
  entry: QuotaProvider,
  reportedAt: DateTime.Utc,
  readings: ReadonlyArray<JoinedReading>,
  now: DateTime.Utc,
): SourcedProvider => {
  const readAt = entry.state.refreshedAt ?? reportedAt;
  const nowMillis = DateTime.toEpochMillis(now);
  const readMillis = DateTime.toEpochMillis(readAt);
  const own = readings.filter((joined) => joined.entry === entry);
  const windows = entry.windows.map((window): SourcedWindow => {
    const asRead: SourcedWindow = { ...window, source: { kind: "quota-axi", readAt } };
    if (!("percentRemaining" in window)) return asRead;
    const newer = own.find(
      ({ reading }) => reading.windowId === window.id && reading.resetsAt > nowMillis && reading.observedAt > readMillis,
    );
    return newer === undefined ? asRead : harvestedWindow(window, newer.reading, newer.join, nowMillis);
  });
  return { ...entry, reportedAt, windows };
};
