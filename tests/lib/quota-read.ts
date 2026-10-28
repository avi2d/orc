import { Clock, DateTime, Effect, Layer } from "effect";
import {
  type Captured,
  decodeQuota,
  HarvestLogSource,
  type HarvestedReading,
  homeLogRoots,
  type LogFile,
  nothingCaptured,
  type Outcome,
  type QuotaProviderId,
  type QuotaRead,
  type QuotaReport,
  QuotaSource,
  type Reading,
  readQuota,
} from "@tui-dash/schema";

// quota-axi asked about every provider, as when no log reading is fresh enough to stand in for one.
export const quotaAxiRead = (quotaAxi: Reading<QuotaReport>, logReadings: ReadonlyArray<HarvestedReading> = []): QuotaRead => ({
  quotaAxi,
  logAccounts: [],
  logReadings,
  accounts: [],
});

// quota-axi lists exactly the providers its --provider flag names.
const askedOnly = (report: Outcome<QuotaReport>, providers: ReadonlyArray<QuotaProviderId>): Outcome<QuotaReport> =>
  report.kind === "ok"
    ? { ...report, value: { ...report.value, providers: report.value.providers.filter((entry) => providers.includes(entry.provider)) } }
    : report;

export const quotaAxiJsonFor = (argv: ReadonlyArray<string>, text: string): string => {
  const asked = argv.at(argv.indexOf("--provider") + 1)?.split(",") ?? [];
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || !("providers" in parsed) || !Array.isArray(parsed.providers)) {
    throw new Error("the fixture holds no quota report");
  }
  const providers: ReadonlyArray<unknown> = parsed.providers;
  return JSON.stringify({
    ...parsed,
    providers: providers.filter(
      (entry) => typeof entry === "object" && entry !== null && "provider" in entry && asked.includes(String(entry.provider)),
    ),
  });
};

const stoppedAt = (now: DateTime.Utc): Clock.Clock => {
  const millis = DateTime.toEpochMillis(now);
  const nanos = BigInt(millis) * 1_000_000n;
  return {
    currentTimeMillisUnsafe: () => millis,
    currentTimeMillis: Effect.succeed(millis),
    currentTimeNanosUnsafe: () => nanos,
    currentTimeNanos: Effect.succeed(nanos),
    monotonicTimeNanosUnsafe: () => nanos,
    monotonicTimeNanos: Effect.succeed(nanos),
    sleep: () => Effect.void,
  };
};

// The shared read, run at a recorded instant over log files already on hand and a recorded quota-axi report.
export const recordedQuotaRead = (
  quotaJson: string,
  now: DateTime.Utc,
  logs: ReadonlyArray<LogFile>,
  captured: Captured = nothingCaptured,
): QuotaRead =>
  Effect.runSync(
    readQuota.pipe(
      Effect.provide(
        Layer.merge(
          Layer.succeed(QuotaSource, {
            read: (providers) => Effect.succeed({ ...askedOnly(decodeQuota(quotaJson), providers), capturedAt: now }),
          }),
          Layer.succeed(HarvestLogSource, { read: () => Effect.succeed({ home: "/home/tester", roots: homeLogRoots("/home/tester"), files: logs, captured }) }),
        ),
      ),
      Effect.provideService(Clock.Clock, stoppedAt(now)),
    ),
  );
