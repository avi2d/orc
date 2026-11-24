import { Context, Duration, Layer, Schema } from "effect";
import type { CommandRunner } from "../../../shared/lib";
import { type Decoded, decodeJson } from "../../../shared/lib";
import { runDecoded, sourceOf, stamped, type Source } from "../../../shared/lib";

export const orcQuotaUnreadCauses = ["command-missing", "exit", "timeout", "no-json", "spawn", "schema", "account-missing"] as const;

export type OrcQuotaUnreadCause = (typeof orcQuotaUnreadCauses)[number];

const OrcQuotaAccount = Schema.Union([
  Schema.Struct({
    account: Schema.String,
    kind: Schema.Literal("usable"),
    remainingPercent: Schema.Finite,
    resetsAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  }),
  Schema.Struct({ account: Schema.String, kind: Schema.Literal("unusable"), reason: Schema.String }),
]);

const OrcQuota = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("read"),
    floorPercent: Schema.Finite,
    accounts: Schema.Array(OrcQuotaAccount),
    pick: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("unread"), cause: Schema.Literals(orcQuotaUnreadCauses), reason: Schema.String }),
]);

export type OrcQuota = typeof OrcQuota.Type;
export type OrcQuotaAccount = typeof OrcQuotaAccount.Type;

export const decodeOrcQuota: (stdout: string) => Decoded<OrcQuota> = decodeJson(OrcQuota);

// orc quota runs the quota command under its own 15 second limit, so this one leaves room for orc to start and print.
const orcQuotaTimeout = Duration.seconds(20);

export class OrcQuotaSource extends Context.Service<OrcQuotaSource, Source<OrcQuota>>()("orc-dash/OrcQuotaSource") {}

export const orcQuotaSourceLayer: Layer.Layer<OrcQuotaSource, never, CommandRunner> = Layer.effect(
  OrcQuotaSource,
  sourceOf(stamped(runDecoded({ argv: ["orc", "quota", "--json"], timeout: orcQuotaTimeout }, decodeOrcQuota))),
);
