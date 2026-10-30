import { DateTime, Option } from "effect";
import { type Decoded, decoded, flatMapDecoded, rejected } from "../decode";
import type { Failed } from "../reading";
import type { HarvestOrigin } from "../sessions/harvest";
import type { Session, SessionIdentity } from "../sessions/live";
import type { Tokens } from "../sessions/tokens";
import { spendGate } from "../views/estimate";
import type { AccountView, SessionQuotaView, SessionShare, WindowView } from "../views/session-quota";
import type { WindowSource } from "../views/window-sources";
import type { SessionQuotaReport } from "./session-quota";

type Report = SessionQuotaReport;

type SessionJson = Report["sessions"][number];

type WindowJson = Report["windows"][number];

type StatusJson = Report["sources"]["quota"];

const mapDecoded = <A, B>(value: Decoded<A>, f: (a: A) => B): Decoded<B> =>
  flatMapDecoded(value, (a) => decoded(f(a)));

const eachDecoded = <A, B>(items: ReadonlyArray<A>, f: (item: A, index: number) => Decoded<B>): Decoded<ReadonlyArray<B>> =>
  items.reduce<Decoded<ReadonlyArray<B>>>(
    (done, item, index) => flatMapDecoded(done, (kept) => mapDecoded(f(item, index), (next) => [...kept, next])),
    decoded([]),
  );

const failedOf = (status: StatusJson): Failed | undefined => {
  if (status.status === "ok") return undefined;
  const detail = status.detail ?? `${status.status} with no detail`;
  return status.status === "unreachable" ? { kind: "unreachable", reason: detail } : { kind: "invalid", issue: detail };
};

const tokensOf = ({ total: _, ...tokens }: WindowJson["observed"]["tokens"]): Tokens => tokens;

const instantOf = (text: string, where: string): Decoded<DateTime.Utc> =>
  Option.match(DateTime.make(text), {
    onNone: () => rejected(`${where} is not an instant`),
    onSome: (value) => decoded(DateTime.toUtc(value)),
  });

const identityOf = (session: SessionJson, where: string): Decoded<SessionIdentity> => {
  switch (session.kind) {
    case "pane":
      return session.pane === undefined
        ? rejected(`${where} is a pane with no pane id`)
        : decoded({ kind: "pane", pane: session.pane, status: session.paneStatus });
    case "process":
      return session.pid === undefined
        ? rejected(`${where} is a process with no pid`)
        : decoded({ kind: "process", pid: session.pid });
    case "ended":
      return decoded({ kind: "ended" });
  }
};

const sessionOf = (session: SessionJson, index: number, machine: string): Decoded<Session> =>
  mapDecoded(identityOf(session, `sessions[${index}]`), (identity) => ({
    id: session.id,
    identity,
    harness: session.harness,
    cwd: session.cwd ?? undefined,
    place: session.place,
    files: session.files,
    machine,
  }));

const rowsOf = (
  window: WindowJson,
  where: string,
  sessions: ReadonlyMap<string, Session>,
): Decoded<ReadonlyArray<Omit<SessionShare, "flagged">>> =>
  eachDecoded(window.sessions, (row, index) => {
    const session = sessions.get(row.session);
    return session === undefined
      ? rejected(`${where}.sessions[${index}] names no listed session`)
      : decoded({
          session,
          label: row.label,
          calls: row.calls,
          tokens: tokensOf(row.tokens),
          trailingHourTokens: tokensOf(row.trailingHourTokens),
          raw: row.raw,
          priced: row.priced,
          models: (row.models ?? []).map((model) => ({
            model: model.model ?? undefined,
            calls: model.calls,
            tokens: tokensOf(model.tokens),
            trailingHourTokens: tokensOf(model.trailingHourTokens),
            priced: model.priced,
          })),
        });
  });

const originOf = (source: Exclude<WindowJson["source"], undefined | { readonly kind: "quota-axi" }>): HarvestOrigin =>
  source.harness === "codex" ? { harness: "codex", via: "log" } : { harness: "claude-code", via: source.via ?? "log" };

// A report with no window source predates log harvesting, when every window came from the quota-axi read its report made.
const sourceOf = (window: WindowJson, where: string, reportedAt: DateTime.Utc): Decoded<WindowSource> => {
  const source = window.source;
  if (source === undefined) return decoded({ kind: "quota-axi", readAt: reportedAt });
  if (source.kind === "quota-axi") {
    return mapDecoded(instantOf(source.readAt, `${where}.source.readAt`), (readAt) => ({ kind: "quota-axi", readAt }));
  }
  return mapDecoded(instantOf(source.observedAt, `${where}.source.observedAt`), (observedAt) => ({
    kind: "harvested",
    ...originOf(source),
    observedAt,
    file: source.file,
    join: source.join,
  }));
};

const windowOf = (
  window: WindowJson,
  where: string,
  sessions: ReadonlyMap<string, Session>,
  reportedAt: DateTime.Utc,
): Decoded<WindowView> =>
  flatMapDecoded(instantOf(window.startsAt, `${where}.startsAt`), (startsAt) =>
    flatMapDecoded(instantOf(window.resetsAt, `${where}.resetsAt`), (resetsAt) =>
      flatMapDecoded(sourceOf(window, where, reportedAt), (source) =>
        mapDecoded(rowsOf(window, where, sessions), (rows) => {
          const gate = spendGate(
            rows,
            window.gate.aheadOfPace && window.gate.pastFirstTenth,
            window.sustainablePointsPerHour,
            window.verdict ?? null,
          );
          return {
            id: window.id,
            label: window.label,
            kind: window.kind,
            source,
            cycleSeconds: (DateTime.toEpochMillis(resetsAt) - DateTime.toEpochMillis(startsAt)) / 1000,
            startsAt,
            resetsAt,
            usedPoints: window.usedPoints,
            leftPoints: window.leftPoints,
            pace: window.pace,
            elapsedFraction: window.elapsedFraction,
            aheadOfPace: window.gate.aheadOfPace,
            pastFirstTenth: window.gate.pastFirstTenth,
            exhaustsBeforeReset: gate.exhaustsBeforeReset,
            verdict: window.verdict ?? null,
            sustainablePointsPerHour: window.sustainablePointsPerHour,
            activeSessions: window.activeSessions,
            fairPointsPerHour: window.fairPointsPerHour,
            observedCalls: window.observed.calls,
            observedTokens: tokensOf(window.observed.tokens),
            unattributedPoints: window.unattributedPoints,
            sessions: rows.map((row) => ({ ...row, flagged: gate.flagged.has(row.session) })),
            otherCycle: [],
          };
        }),
      ),
    ),
  );

const sameAccount = (left: WindowJson["account"], right: WindowJson["account"]): boolean =>
  left.provider === right.provider && left.accountKey === right.accountKey;

const accountsOf = (
  report: Report,
  sessions: ReadonlyMap<string, Session>,
  reportedAt: DateTime.Utc,
): Decoded<ReadonlyArray<AccountView>> =>
  eachDecoded(report.accounts, ({ quota, joins, ...account }): Decoded<AccountView> => {
    const head = {
      provider: account.provider,
      accountKey: account.accountKey ?? undefined,
      credentialKey: account.credentialKey ?? undefined,
      accountKeys: account.accountKeys ?? [],
      title: account.title,
      joins,
    };
    const failed = failedOf(quota);
    if (failed !== undefined) return decoded({ ...head, body: failed });
    const own = report.windows.flatMap((window, index) => (sameAccount(window.account, account) ? [{ window, index }] : []));
    return mapDecoded(
      eachDecoded(own, ({ window, index }) => windowOf(window, `windows[${index}]`, sessions, reportedAt)),
      (windows) => ({ ...head, body: { kind: "windows", windows } }),
    );
  });

// The report's schema holds each field's shape but not that its instants parse or that its rows name its sessions.
export const sessionQuotaViewOf = (report: Report, machine: string): Decoded<SessionQuotaView> =>
  flatMapDecoded(instantOf(report.generatedAt, "generatedAt"), (now) =>
    flatMapDecoded(
      eachDecoded(report.sessions, (session, index) => sessionOf(session, index, machine)),
      (sessions) =>
        mapDecoded(accountsOf(report, new Map(sessions.map((session) => [session.id, session])), now), (accounts) => {
          const { unjoinedCalls, ...ledger } = report.ledger;
          return {
            now,
            quota: failedOf(report.sources.quota),
            panes: failedOf(report.sources.herdr),
            processes: failedOf(report.sources.processes),
            accounts,
            sessions,
            modelsSinceMidnight: sessions.flatMap((session, index) => {
              const models = report.sessions[index]?.modelsSinceMidnight ?? [];
              return models.length === 0
                ? []
                : [
                    {
                      session,
                      models: models.map((model) => ({ model: model.model ?? undefined, tokens: tokensOf(model.tokens), provider: model.provider ?? undefined })),
                      firstCallAt: undefined,
                    },
                  ];
            }),
            unmatched: report.unmatchedProcesses.map((runs) => ({ ...runs, machine })),
            panePresence: (report.panePresence ?? []).map((pane) => ({ pane: pane.pane, status: pane.paneStatus, tie: pane.tie, machine })),
            headlessFolders: (report.headlessFolders ?? []).map((folder) => ({ ...folder, machine })),
            ledger,
            unmetered: report.unmetered.map(({ route, calls, tokens }) => ({ route, calls, tokens: tokensOf(tokens) })),
            unjoinedCalls,
          };
        }),
    ),
  );
