import { Context, Duration, Effect, Layer, Schema } from "effect";
import { CommandRunner } from "../command";
import { type Decoded, decodeJson, decodeValue, decoded, flatMapDecoded, rejected } from "../decode";
import type { Failed, Reading } from "../reading";
import { runDecoded, stamped } from "../source";

const Instant = Schema.DateTimeUtcFromString;
const Confidence = Schema.Literals(["early", "established"]);

export const shownQuotaProviders = ["claude", "codex", "opencode-go"] as const;

export type QuotaProviderId = (typeof shownQuotaProviders)[number];

const ShownProviderId = Schema.Literals(shownQuotaProviders);

const isShownProviderId = Schema.is(ShownProviderId);

const ProviderEntry = Schema.Struct({
  provider: Schema.String,
  accountKey: Schema.optionalKey(Schema.String),
  notSetUp: Schema.optionalKey(Schema.Boolean),
});

const Pace = Schema.Struct({
  status: Schema.Literals(["ahead", "on_pace", "behind", "unknown"]),
  reason: Schema.optionalKey(Schema.String),
  reservePercentPoints: Schema.optionalKey(Schema.Finite),
  timeRemainingPercent: Schema.optionalKey(Schema.Finite),
  cycleSeconds: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))),
  projectedExhaustedAt: Schema.optionalKey(Instant),
  projectionConfidence: Schema.optionalKey(Confidence),
});

const windowFields = {
  id: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(["session", "weekly", "monthly", "model", "credits", "unknown"]),
  windowSeconds: Schema.optionalKey(Schema.Finite),
  resetsAt: Schema.optionalKey(Instant),
  pace: Schema.optionalKey(Pace),
};

// quota-axi omits percentRemaining only on a window that is a share of a parent, so a window with neither is a format change.
export const QuotaWindow = Schema.Union([
  Schema.Struct({ ...windowFields, percentRemaining: Schema.Finite }),
  Schema.Struct({ ...windowFields, shareOf: Schema.String }),
]);

const Runway = Schema.Struct({
  status: Schema.Literals(["exhausted_now", "projected_exhaustion", "through_reset", "unknown"]),
  usableRunwaySeconds: Schema.optionalKey(Schema.Finite),
  projectedExhaustedAt: Schema.optionalKey(Instant),
  limitingWindowId: Schema.optionalKey(Schema.String),
  projectionConfidence: Schema.optionalKey(Confidence),
});

export const QuotaAvailability = Schema.Struct({
  scope: Schema.String,
  status: Schema.Literals(["known", "unknown"]),
  effectivePercentRemaining: Schema.optionalKey(Schema.Finite),
  runway: Schema.optionalKey(Runway),
});

export const QuotaProviderState = Schema.Struct({
  status: Schema.Literals(["fresh", "stale", "unavailable", "auth_required", "rate_limited", "error"]),
  stale: Schema.Boolean,
  refreshedAt: Schema.optionalKey(Instant),
  error: Schema.optionalKey(Schema.String),
});

const ShownProvider = Schema.Struct({
  provider: ShownProviderId,
  accountKey: Schema.optionalKey(Schema.String),
  accountKeys: Schema.optionalKey(Schema.Array(Schema.String)),
  plan: Schema.optionalKey(Schema.String),
  windows: Schema.Array(QuotaWindow),
  quotaSemantics: Schema.optionalKey(
    Schema.Struct({
      status: Schema.Literals(["known", "partial", "unknown"]),
      effectiveAvailability: Schema.Array(QuotaAvailability),
    }),
  ),
  state: QuotaProviderState,
});

const Envelope = Schema.Struct({
  generatedAt: Instant,
  schemaVersion: Schema.Literals([5, 6]),
  providers: Schema.Array(Schema.Unknown),
});

export type QuotaWindow = typeof QuotaWindow.Type;
export type QuotaAvailability = typeof QuotaAvailability.Type;
export type QuotaProvider = typeof ShownProvider.Type;

export type FailedQuotaEntry = { readonly provider: typeof ShownProviderId.Type; readonly accountKey: string | undefined } & Failed;

export type QuotaProviderEntry = QuotaProvider | FailedQuotaEntry;

export interface QuotaReport {
  readonly generatedAt: typeof Envelope.Type.generatedAt;
  readonly providers: ReadonlyArray<QuotaProviderEntry>;
  readonly notSetUp: ReadonlyArray<QuotaProviderId>;
}

type ShownEntries = Pick<QuotaReport, "providers" | "notSetUp">;

const decodeShown = (raw: ReadonlyArray<unknown>): Decoded<ShownEntries> => {
  const shown: Array<QuotaProviderEntry> = [];
  const notSetUp: Array<QuotaProviderId> = [];
  for (const [index, entry] of raw.entries()) {
    const id = decodeValue(ProviderEntry)(entry);
    if (id.kind === "invalid") return rejected(`providers[${index}]: ${id.issue}`);
    if (!isShownProviderId(id.value.provider)) continue;
    if (id.value.notSetUp === true) {
      notSetUp.push(id.value.provider);
      continue;
    }
    const provider = decodeValue(ShownProvider)(entry);
    if (provider.kind === "ok") {
      shown.push(provider.value);
    } else {
      shown.push({
        provider: id.value.provider,
        accountKey: id.value.accountKey,
        kind: "invalid",
        issue: `provider ${id.value.provider}: ${provider.issue}`,
      });
    }
  }
  return decoded({ providers: shown, notSetUp });
};

export const decodeQuota = (stdout: string): Decoded<QuotaReport> =>
  flatMapDecoded(decodeJson(Envelope)(stdout), ({ generatedAt, providers }) =>
    flatMapDecoded(decodeShown(providers), (shown) => decoded({ generatedAt, ...shown })),
  );

// quota-axi takes one --max-age for the whole read, so the other providers asked beside Claude are reused as long.
const claudeReuse = ["--max-age", "5m"] as const;

const quotaCommand = (providers: ReadonlyArray<QuotaProviderId>) =>
  ({
    argv: ["quota-axi", "--full", "--json", "--provider", providers.join(","), ...(providers.includes("claude") ? claudeReuse : [])],
    // quota-axi exits 1 when every provider failed, and still prints the whole report.
    exitCodes: [0, 1],
    timeout: Duration.seconds(25),
  }) as const;

export class QuotaSource extends Context.Service<
  QuotaSource,
  { readonly read: (providers: ReadonlyArray<QuotaProviderId>) => Effect.Effect<Reading<QuotaReport>> }
>()("tui-dash/QuotaSource") {}

export const quotaSourceLayer = Layer.effect(
  QuotaSource,
  Effect.gen(function* () {
    const runner = yield* CommandRunner;
    return {
      read: (providers: ReadonlyArray<QuotaProviderId>) =>
        Effect.provideService(stamped(runDecoded(quotaCommand(providers), decodeQuota)), CommandRunner, runner),
    };
  }),
);
