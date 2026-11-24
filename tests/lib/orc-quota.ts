import { type DateTime, Effect, Layer } from "effect";
import { CommandRunner, decodeOrcQuota, type OrcQuota, type OrcQuotaSource, orcQuotaSourceLayer, type Reading } from "@avi2dg/orc-schema";
import { fixture } from "./fixtures";

export type OrcQuotaFixture =
  | "main-second"
  | "main"
  | "codex-under-floor"
  | "second-missing"
  | "command-missing"
  | "second-unusable"
  | "second-spare"
  | "second-used-up"
  | "second-login-expired";

export const recordedOrcQuota: OrcQuotaFixture = "second-login-expired";

export const orcQuotaText = (name: OrcQuotaFixture): string => fixture(`orc-quota/${name}.json`);

export const orcQuotaReading = (text: string, capturedAt: DateTime.Utc): Reading<OrcQuota> => {
  const decoded = decodeOrcQuota(text);
  if (decoded.kind !== "ok") throw new Error(`the orc quota reading does not decode: ${decoded.issue}`);
  return { ...decoded, capturedAt };
};

export const orcQuotaOf = (name: OrcQuotaFixture, capturedAt: DateTime.Utc): Reading<OrcQuota> => orcQuotaReading(orcQuotaText(name), capturedAt);

export const noOrcAccounts = (capturedAt: DateTime.Utc): Reading<OrcQuota> => ({
  kind: "ok",
  value: { kind: "read", floorPercent: 20, accounts: [], pick: null },
  capturedAt,
});

export const recordedOrcQuotaLayer = (name: OrcQuotaFixture = recordedOrcQuota): Layer.Layer<OrcQuotaSource> =>
  orcQuotaSourceLayer.pipe(Layer.provide(Layer.succeed(CommandRunner, { run: () => Effect.succeed(orcQuotaText(name)) })));
