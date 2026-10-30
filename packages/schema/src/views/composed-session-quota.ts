import { DateTime } from "effect";
import type { Outcome } from "../reading";
import type { Session } from "../sessions/live";
import { addTokens, sumTokens, type Tokens, type Weighting, weightings } from "../sessions/tokens";
import { byPricedShare, estimate, rateSpanHours, spendGate } from "./estimate";
import { type AccountJoin, sameJoin } from "./account-join";
import {
  type AccountView,
  type Composition,
  type FailedAccount,
  type RemoteState,
  type SessionQuotaView,
  type SessionShare,
  type Unmetered,
  type WindowView,
} from "./session-quota";

const staleAfterMillis = 5 * 60_000;

// quota-axi reads the vendor's reset instant on each machine, so one cycle of one account agrees to well inside a minute.
const sameCycleMillis = 60_000;

export interface RemoteReading {
  readonly name: string;
  readonly reading: Outcome<SessionQuotaView>;
}

interface Machine {
  readonly name: string;
  readonly view: SessionQuotaView;
}

const onMachine = (view: SessionQuotaView, machine: string): SessionQuotaView => {
  const tagged = new Map(view.sessions.map((session) => [session.id, { ...session, machine }]));
  const retag = (session: Session): Session => tagged.get(session.id) ?? { ...session, machine };
  return {
    ...view,
    sessions: [...tagged.values()],
    panePresence: (view.panePresence ?? []).map((pane) => ({ ...pane, machine })),
    headlessFolders: (view.headlessFolders ?? []).map((folder) => ({ ...folder, machine })),
    modelsSinceMidnight: view.modelsSinceMidnight.map((entry) => ({ ...entry, session: retag(entry.session) })),
    unmatched: view.unmatched.map((runs) => ({ ...runs, machine })),
    accounts: view.accounts.map((account) =>
      account.body.kind === "windows"
        ? {
            ...account,
            body: {
              kind: "windows",
              windows: account.body.windows.map((window) => ({
                ...window,
                sessions: window.sessions.map((row) => ({ ...row, session: retag(row.session) })),
              })),
            },
          }
        : account,
    ),
  };
};

const stateOf = (reading: Outcome<SessionQuotaView>, now: DateTime.Utc): RemoteState => {
  if (reading.kind !== "ok") return reading;
  const { now: generatedAt, quota, panes, processes } = reading.value;
  return DateTime.toEpochMillis(now) - DateTime.toEpochMillis(generatedAt) > staleAfterMillis
    ? { kind: "stale", generatedAt }
    : { kind: "ok", generatedAt, quota, panes, processes };
};

interface Member {
  readonly machine: Machine;
  readonly window: WindowView;
}

interface WindowGroup {
  readonly members: Array<Member>;
  readonly otherCycle: Array<string>;
}

const sameCycle = (left: WindowView, right: WindowView): boolean =>
  Math.abs(DateTime.toEpochMillis(left.resetsAt) - DateTime.toEpochMillis(right.resetsAt)) <= sameCycleMillis;

const groupedWindows = (found: ReadonlyArray<{ readonly machine: Machine; readonly windows: ReadonlyArray<WindowView> }>) => {
  const groups: Array<WindowGroup> = [];
  for (const { machine, windows } of found) {
    for (const window of windows) {
      const group = groups.find((known) => known.members.at(0)?.window.id === window.id);
      const anchor = group?.members.at(0)?.window;
      if (group === undefined || anchor === undefined) groups.push({ members: [{ machine, window }], otherCycle: [] });
      else if (sameCycle(anchor, window)) group.members.push({ machine, window });
      else group.otherCycle.push(machine.name);
    }
  }
  return groups;
};

const weightOf = (tokens: Tokens, weighting: Weighting): number => weightings[weighting](tokens);

// The first machine's quota reading stands for the account, and every machine's calls are a share of the calls both observed.
const combinedWindow = (anchor: WindowView, members: ReadonlyArray<Member>): WindowView => {
  const observedTokens = sumTokens(members.map(({ window }) => window.observedTokens));
  const all = { raw: weightOf(observedTokens, "raw"), priced: weightOf(observedTokens, "priced") };
  const rows = members.flatMap(({ machine, window }) => {
    const span = rateSpanHours(
      DateTime.toEpochMillis(window.startsAt),
      DateTime.toEpochMillis(window.resetsAt),
      DateTime.toEpochMillis(machine.view.now),
    );
    return window.sessions.map(({ flagged: _, ...row }) => {
      const mine = (weighting: Weighting) => ({
        window: weightOf(row.tokens, weighting),
        hour: weightOf(row.trailingHourTokens, weighting),
      });
      return {
        ...row,
        raw: estimate(mine("raw"), all.raw, anchor.usedPoints, span),
        priced: estimate(mine("priced"), all.priced, anchor.usedPoints, span),
        models: row.models.map((model) => ({
          ...model,
          priced: estimate(
            { window: weightOf(model.tokens, "priced"), hour: weightOf(model.trailingHourTokens, "priced") },
            all.priced,
            anchor.usedPoints,
            span,
          ),
        })),
      };
    });
  });
  const gate = spendGate(rows, anchor.aheadOfPace && anchor.pastFirstTenth, anchor.sustainablePointsPerHour, anchor.verdict);
  const observedCalls = members.reduce((sum, { window }) => sum + window.observedCalls, 0);
  return {
    ...anchor,
    exhaustsBeforeReset: gate.exhaustsBeforeReset,
    activeSessions: gate.burning,
    fairPointsPerHour: gate.fairPointsPerHour,
    observedCalls,
    observedTokens,
    unattributedPoints: observedCalls === 0 ? anchor.usedPoints : 0,
    sessions: rows
      .toSorted(byPricedShare)
      .map((row): SessionShare => ({ ...row, flagged: gate.flagged.has(row.session) })),
  };
};

const windowOfGroup = ({ members, otherCycle }: WindowGroup): ReadonlyArray<WindowView> => {
  const anchor = members.at(0)?.window;
  if (anchor === undefined) return [];
  return [{ ...(members.length === 1 ? anchor : combinedWindow(anchor, members)), otherCycle }];
};

// A log account carries no accountKey and a peer's report may carry no credentialKey or accountKeys, so no one key names the login on both.
const keysCarried = (account: AccountView): ReadonlyArray<string> => [
  ...(account.accountKey === undefined ? [] : [account.accountKey]),
  ...(account.credentialKey === undefined ? [] : [account.credentialKey]),
  ...account.accountKeys,
  ...account.joins.flatMap((join) => (join.kind === "credential-key" ? [join.key] : [])),
];

interface Found {
  readonly order: number;
  readonly machine: Machine;
  readonly account: AccountView;
}

type Login = ReadonlyArray<Found>;

const sharesKey = (login: Login, account: AccountView): boolean =>
  login.some(
    (member) =>
      member.account.provider === account.provider && keysCarried(member.account).some((key) => keysCarried(account).includes(key)),
  );

// Accounts sharing any key are one login, transitively. quota-axi leaves a provider's one account unkeyed, so an account with
// no key joins the provider's one keyed login, or the other keyless ones when none is keyed, and stands alone beside two.
const logins = (found: ReadonlyArray<Found>): ReadonlyArray<Login> => {
  const keyed = found.reduce<ReadonlyArray<Login>>((known, member) => {
    if (keysCarried(member.account).length === 0) return known;
    const shared = known.filter((login) => sharesKey(login, member.account));
    return [...known.filter((login) => !shared.includes(login)), [...shared.flat(), member]];
  }, []);
  const all = [...new Set(found.map(({ account }) => account.provider))].flatMap((provider): ReadonlyArray<Login> => {
    const own = keyed.filter((login) => login.at(0)?.account.provider === provider);
    const keyless = found.filter(({ account }) => account.provider === provider && keysCarried(account).length === 0);
    const only = own.length === 1 ? own.at(0) : undefined;
    if (keyless.length === 0) return own;
    if (only !== undefined) return [[...only, ...keyless]];
    return own.length === 0 ? [keyless] : [...own, ...keyless.map((member) => [member])];
  });
  const firstOf = (login: Login): number => Math.min(...login.map(({ order }) => order));
  return all.map((login) => login.toSorted((left, right) => left.order - right.order)).toSorted((left, right) => firstOf(left) - firstOf(right));
};

const joinsOf = (accounts: ReadonlyArray<AccountView>): ReadonlyArray<AccountJoin> =>
  accounts
    .flatMap((account) => account.joins)
    .reduce<ReadonlyArray<AccountJoin>>((seen, join) => (seen.some((known) => sameJoin(known, join)) ? seen : [...seen, join]), []);

interface MergedAccount {
  readonly account: AccountView;
  readonly failed: ReadonlyArray<FailedAccount>;
}

// An account shows one machine's failure as its body only when no machine read its windows, and every other failure is kept beside it.
const mergedAccounts = (machines: ReadonlyArray<Machine>): ReadonlyArray<MergedAccount> => {
  const everyAccount = machines
    .flatMap((machine) => machine.view.accounts.map((account) => ({ machine, account })))
    .map((member, order) => ({ ...member, order }));
  return logins(everyAccount).flatMap((found) => {
    const head = found.at(0)?.account;
    if (head === undefined) return [];
    const metered = found.flatMap(({ machine, account }) =>
      account.body.kind === "windows" ? [{ machine, account, windows: account.body.windows }] : [],
    );
    const failed = found.flatMap(({ machine, account }): ReadonlyArray<FailedAccount> =>
      account.body.kind === "windows" || (metered.length === 0 && account === head)
        ? []
        : [{ machine: machine.name, account, failure: account.body }],
    );
    const merged = {
      ...head,
      accountKeys: [...new Set(found.flatMap(({ account }) => account.accountKeys))],
      joins: joinsOf(found.map(({ account }) => account)),
    };
    if (metered.length === 0) return [{ account: merged, failed }];
    const windows = groupedWindows(metered).flatMap(windowOfGroup);
    return [{ account: { ...merged, body: { kind: "windows" as const, windows } }, failed }];
  });
};

const mergedUnmetered = (machines: ReadonlyArray<Machine>): ReadonlyArray<Unmetered> => {
  const byRoute = new Map<string, Unmetered>();
  for (const entry of machines.flatMap(({ view }) => view.unmetered)) {
    const known = byRoute.get(entry.route);
    byRoute.set(
      entry.route,
      known === undefined
        ? entry
        : { route: entry.route, calls: known.calls + entry.calls, tokens: addTokens(known.tokens, entry.tokens) },
    );
  }
  return [...byRoute.values()];
};

const summedLedger = (machines: ReadonlyArray<Machine>): SessionQuotaView["ledger"] =>
  machines.reduce(
    (sum, { view }) => ({
      bridgeCopiesDropped: sum.bridgeCopiesDropped + view.ledger.bridgeCopiesDropped,
      repeatedLinesDropped: sum.repeatedLinesDropped + view.ledger.repeatedLinesDropped,
      emptyRowsDropped: sum.emptyRowsDropped + view.ledger.emptyRowsDropped,
      forkCopiesDropped: sum.forkCopiesDropped + view.ledger.forkCopiesDropped,
      repeatedCountsDropped: sum.repeatedCountsDropped + view.ledger.repeatedCountsDropped,
    }),
    { bridgeCopiesDropped: 0, repeatedLinesDropped: 0, emptyRowsDropped: 0, forkCopiesDropped: 0, repeatedCountsDropped: 0 },
  );

// A remote that failed or answered too long ago adds nothing, so the view keeps this machine's upper bounds and says why.
export const composedSessionQuota = (
  local: SessionQuotaView,
  localName: string,
  remotes: ReadonlyArray<RemoteReading>,
): SessionQuotaView => {
  const states = remotes.map(({ name, reading }) => ({ name, reading, state: stateOf(reading, local.now) }));
  const machines: ReadonlyArray<Machine> = [
    { name: localName, view: onMachine(local, localName) },
    ...states.flatMap(({ name, reading, state }) =>
      state.kind === "ok" && reading.kind === "ok" ? [{ name, view: onMachine(reading.value, name) }] : [],
    ),
  ];
  const merged = mergedAccounts(machines);
  const composition: Composition = {
    local: localName,
    remotes: states.map(({ name, state }) => ({ name, state })),
    failedAccounts: merged.flatMap(({ failed }) => failed),
  };
  return {
    ...local,
    accounts: merged.map(({ account }) => account),
    sessions: machines.flatMap(({ view }) => view.sessions),
    panePresence: machines.flatMap(({ view }) => view.panePresence ?? []),
    headlessFolders: machines.flatMap(({ view }) => view.headlessFolders ?? []),
    modelsSinceMidnight: machines.flatMap(({ view }) => view.modelsSinceMidnight),
    unmatched: machines.flatMap(({ view }) => view.unmatched),
    ledger: summedLedger(machines),
    unmetered: mergedUnmetered(machines),
    unjoinedCalls: machines.reduce((sum, { view }) => sum + view.unjoinedCalls, 0),
    composition,
  };
};
