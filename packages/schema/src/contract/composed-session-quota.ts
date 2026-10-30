import { Schema } from "effect";
import { priceRatios } from "../sessions/tokens";
import type { Failed } from "../reading";
import type { FailedAccount, RemoteState, SessionQuotaView } from "../views/session-quota";
import {
  AccountJson,
  accountJson,
  AccountRef,
  accountRef,
  FlagJson,
  flaggedRows,
  instant,
  LedgerJson,
  modelsSinceMidnightOf,
  PriceRatiosJson,
  SessionJson,
  sessionJson,
  SourcesJson,
  SourceStatus,
  statusOf,
  UnmatchedRunsJson,
  UnmeteredJson,
  unmeteredJson,
  WindowJson,
  windowJson,
  WindowSessionJson,
  windowsOf,
  windowSessionJson,
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

type MachineJson = typeof MachineJson.Type;

const sourcesJson = (quota: Failed | undefined, panes: Failed | undefined, processes: Failed | undefined) => ({
  quota: statusOf(quota),
  herdr: statusOf(panes),
  processes: statusOf(processes),
});

const failedAccountsOn = (machine: string, failed: ReadonlyArray<FailedAccount>): MachineJson["failedAccounts"] =>
  failed.flatMap((entry) => (entry.machine === machine ? [{ ...accountRef(entry.account), quota: statusOf(entry.failure) }] : []));

const remoteJson = (name: string, state: RemoteState, failed: ReadonlyArray<FailedAccount>): MachineJson => {
  const head = { name, role: "remote" as const };
  const unread = { combined: false, sources: null, failedAccounts: [] };
  switch (state.kind) {
    case "ok":
      return {
        ...head,
        status: "ok",
        generatedAt: instant(state.generatedAt),
        combined: true,
        sources: sourcesJson(state.quota, state.panes, state.processes),
        failedAccounts: failedAccountsOn(name, failed),
      };
    case "stale":
      return { ...head, status: "stale", generatedAt: instant(state.generatedAt), ...unread };
    case "unreachable":
      return { ...head, status: "unreachable", detail: state.reason, generatedAt: null, ...unread };
    case "invalid":
      return { ...head, status: "invalid", detail: state.issue, generatedAt: null, ...unread };
  }
};

// Every session in a composed view carries its machine, and a view no remote composed reads as this machine's alone.
export const composedSessionQuotaReport = (view: SessionQuotaView, localName: string): ComposedSessionQuotaReport => {
  const composition = view.composition ?? { local: localName, remotes: [], failedAccounts: [] };
  const machineOf = (machine: string | undefined): string => machine ?? composition.local;
  return {
    schemaVersion: 2,
    generatedAt: instant(view.now),
    scope: "composed",
    estimate: { basis: "machine-logs", upperBound: true, priceRatios: { ...priceRatios } },
    machines: [
      {
        name: composition.local,
        role: "local",
        status: "ok",
        generatedAt: instant(view.now),
        combined: true,
        sources: sourcesJson(view.quota, view.panes, view.processes),
        failedAccounts: failedAccountsOn(composition.local, composition.failedAccounts),
      },
      ...composition.remotes.map(({ name, state }) => remoteJson(name, state, composition.failedAccounts)),
    ],
    ledger: { ...view.ledger, unjoinedCalls: view.unjoinedCalls },
    accounts: view.accounts.map(accountJson),
    windows: view.accounts.flatMap((account) =>
      windowsOf(account).map((window) => ({
        ...windowJson(account, window),
        otherCycle: window.otherCycle,
        sessions: window.sessions.map((row) => ({ ...windowSessionJson(row), machine: machineOf(row.session.machine) })),
      })),
    ),
    sessions: view.sessions.map((session) => ({ ...sessionJson(session, modelsSinceMidnightOf(view, session)), machine: machineOf(session.machine) })),
    unmatchedProcesses: view.unmatched.map(({ machine, ...runs }) => ({ ...runs, machine: machineOf(machine) })),
    flags: flaggedRows(view).map(({ session, flag }) => ({ ...flag, machine: machineOf(session.machine) })),
    unmetered: view.unmetered.map(unmeteredJson),
  };
};
