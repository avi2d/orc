import { Schema } from "effect";
import {
  AccountJson,
  AccountRef,
  FlagJson,
  LedgerJson,
  PriceRatiosJson,
  SessionJson,
  SourceStatus,
  SourcesJson,
  UnmatchedRunsJson,
  UnmeteredJson,
  WindowJson,
  WindowSessionJson,
} from "./session-quota";

const OnMachine = { machine: Schema.String };

const MachineJson = Schema.Struct({
  name: Schema.String,
  role: Schema.Literals(["local", "remote"]),
  status: Schema.Literals(["ok", "unreachable", "invalid", "stale"]),
  detail: Schema.optionalKey(Schema.String),
  generatedAt: Schema.NullOr(Schema.String),
  combined: Schema.Boolean,
  sources: Schema.NullOr(SourcesJson),
  failedAccounts: Schema.Array(Schema.Struct({ ...AccountRef.fields, quota: SourceStatus })),
});

export const ComposedSessionQuotaReport = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  generatedAt: Schema.String,
  scope: Schema.Literal("composed"),
  estimate: Schema.Struct({
    basis: Schema.Literal("machine-logs"),
    upperBound: Schema.Literal(true),
    priceRatios: PriceRatiosJson,
  }),
  machines: Schema.Array(MachineJson),
  ledger: LedgerJson,
  accounts: Schema.Array(AccountJson),
  windows: Schema.Array(
    Schema.Struct({
      ...WindowJson.fields,
      otherCycle: Schema.Array(Schema.String),
      sessions: Schema.Array(Schema.Struct({ ...WindowSessionJson.fields, ...OnMachine })),
    }),
  ),
  sessions: Schema.Array(Schema.Struct({ ...SessionJson.fields, ...OnMachine })),
  unmatchedProcesses: Schema.Array(Schema.Struct({ ...UnmatchedRunsJson.fields, ...OnMachine })),
  flags: Schema.Array(Schema.Struct({ ...FlagJson.fields, ...OnMachine })),
  unmetered: Schema.Array(UnmeteredJson),
});

export type ComposedSessionQuotaReport = typeof ComposedSessionQuotaReport.Type;

export type MachineJson = typeof MachineJson.Type;
