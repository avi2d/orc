import { DateTime, Effect, Schema } from "effect";
import { ok, outcomeOf, type Outcome } from "../../../shared/lib";
import { AccountRef, type AccountJson, type WindowJson } from "../contract/session-quota";
import type { Session } from "../sources/live";
import { readQuotas, sourcedEntries } from "../sources/quota-read";
import { groupLogins, keysCarried } from "./group-logins";
import { type AccountView, accountView, type WindowView } from "./session-quota";

const epoch = Schema.Finite.check(Schema.isBetween({ minimum: -8.64e15, maximum: 8.64e15 }));

const windowFields = {
  id: Schema.String, label: Schema.String, reset: epoch, usedPoints: Schema.Finite, leftPoints: Schema.Finite,
};
const Window = Schema.Union([
  Schema.Struct({ ...windowFields, start: Schema.Null, elapsedFraction: Schema.Null }),
  Schema.Struct({ ...windowFields, start: epoch, elapsedFraction: Schema.Finite }),
]);
const Account = Schema.Struct({
  provider: AccountRef.fields.provider, keys: Schema.Array(Schema.String), title: Schema.String, windows: outcomeOf(Schema.Array(Window)),
});

export const SubscriptionReport = Schema.Struct({
  schemaVersion: Schema.Literal(1), readAt: epoch, accounts: Schema.Array(Account),
});
type Report = typeof SubscriptionReport.Type;

const windowReading = (window: WindowView): typeof Window.Type => {
  const fields = { id: window.id, label: window.label, reset: DateTime.toEpochMillis(window.resetsAt), usedPoints: window.usedPoints, leftPoints: window.leftPoints };
  return window.startsAt === null
    ? { ...fields, start: null, elapsedFraction: null }
    : { ...fields, start: DateTime.toEpochMillis(window.startsAt), elapsedFraction: window.elapsedFraction };
};

export const subscriptionReport = (accounts: ReadonlyArray<AccountView>, now: DateTime.Utc): Report => ({
  schemaVersion: 1,
  readAt: DateTime.toEpochMillis(now),
  accounts: accounts.map((account) => ({
    provider: account.provider, title: account.title, keys: [...new Set(keysCarried(account))],
    windows: account.body.kind === "windows" ? ok(account.body.windows.map(windowReading)) : account.body,
  })),
});

export const readSubscriptions = Effect.gen(function* () {
  const readings = yield* readQuotas;
  const now = yield* DateTime.now;
  const entries = sourcedEntries(readings.quota, now);
  const context = { entries, inputs: { ...readings, now, sessionOfFile: new Map<string, string>() }, sessionsById: new Map<string, Session>() };
  return subscriptionReport(entries.map((entry) => accountView(entry, [], context)), now);
});

type Remote = { readonly name: string; readonly reading: Outcome<Report> };

const windowAnchors = (windows: ReadonlyArray<typeof Window.Type>) =>
  [...Map.groupBy(windows, (window) => window.id).values()].flatMap((group) => {
    const first = group.at(0);
    if (first === undefined) return [];
    return [group.find((w) => Math.abs(w.reset - first.reset) <= 60_000 && w.start !== null) ?? first];
  });

type Overview = {
  readonly warnings: ReadonlyArray<string>;
  readonly accounts: ReadonlyArray<Pick<typeof AccountJson.Type, "title" | "quota">>;
  readonly windows: ReadonlyArray<Pick<typeof WindowJson.Type, "label" | "startsAt" | "resetsAt" | "elapsedFraction" | "usedPoints" | "leftPoints"> & { readonly account: { readonly title: string } }>;
};

export const subscriptionOverview = (local: Report, remotes: ReadonlyArray<Remote>): Overview => {
  const accounts = [
    ...local.accounts.map((account) => ({ ...account, machine: null })),
    ...remotes.flatMap(({ name, reading }) => reading.kind === "ok" && local.readAt - reading.value.readAt <= 300_000
      ? reading.value.accounts.map((account) => ({ ...account, machine: name })) : []),
  ];
  const rows = groupLogins(accounts.map((account, order) => ({ ...account, order }))).flatMap((login) => {
    const first = login.at(0);
    if (first === undefined) return [];
    const windows = windowAnchors(login.flatMap((a) => a.windows.kind === "ok" ? a.windows.value : []));
    const failed = login.find((a) => a.windows.kind !== "ok");
    const failure = windows.length === 0 ? failed?.windows : undefined;
    const prefix = failed?.machine == null ? "" : failed.machine + ": ";
    const quota: typeof AccountJson.Type["quota"] = failure === undefined || failure.kind === "ok" ? { status: "ok" }
      : { status: failure.kind, detail: prefix + (failure.kind === "invalid" ? failure.issue : failure.reason) };
    return [{ title: first.title, quota, windows }];
  });
  return {
      warnings: remotes.flatMap(({ name, reading }) => reading.kind !== "ok"
        ? [name + ": " + (reading.kind === "invalid" ? reading.issue : reading.reason)]
        : local.readAt - reading.value.readAt > 300_000 ? [name + ": quota reading is stale"] : []),
      accounts: rows.map(({ title, quota }) => ({ title, quota })),
      windows: rows.flatMap(({ title, windows }) => windows.map(({ label, start, reset, elapsedFraction, usedPoints, leftPoints }) => ({
        account: { title }, label, startsAt: start === null ? null : new Date(start).toISOString(),
        resetsAt: new Date(reset).toISOString(), elapsedFraction, usedPoints, leftPoints,
      }))),
  };
};
