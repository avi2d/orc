import { DateTime } from "effect";
import type { CountedCall } from "../sessions/ledger";
import type { Session } from "../sessions/live";
import type { QuotaProviderId } from "../sources/quota";
import { sumTokens, type Tokens, tokenTotal } from "../sessions/tokens";

export interface ModelTokens {
  readonly model: string | undefined;
  readonly tokens: Tokens;
  readonly provider: QuotaProviderId | undefined;
}

export interface SessionModels {
  readonly session: Session;
  readonly models: ReadonlyArray<ModelTokens>;
  // A report from another machine carries no call times, so a session read from one has no first call.
  readonly firstCallAt: DateTime.Utc | undefined;
}

interface Day {
  readonly now: DateTime.Utc;
  readonly timeZone: DateTime.TimeZone;
  readonly sessionOfFile: ReadonlyMap<string, string>;
}

export const localMidnight = (now: DateTime.Utc, timeZone: DateTime.TimeZone): number =>
  DateTime.toEpochMillis(DateTime.startOf(DateTime.setZone(now, timeZone), "day"));

// Every call of the session counts, metered or not and in any window or none, so a reset during the day drops nothing.
export const sessionModelsSinceMidnight = (
  calls: ReadonlyArray<CountedCall>,
  { now, timeZone, sessionOfFile }: Day,
  sessionsById: ReadonlyMap<string, Session>,
): ReadonlyArray<SessionModels> => {
  const since = localMidnight(now, timeZone);
  const today = calls.filter((call) => call.at >= since && call.at <= DateTime.toEpochMillis(now));
  return [...Map.groupBy(today, (call) => sessionOfFile.get(call.file)).entries()].flatMap(([id, mine]) => {
    const session = id === undefined ? undefined : sessionsById.get(id);
    if (session === undefined) return [];
    const models = [...Map.groupBy(mine, (call) => call.model).entries()]
      .map(([model, own]) => ({
        model,
        tokens: sumTokens(own.map((call) => call.tokens)),
        provider: [...Map.groupBy(own, (call) => call.quota).entries()]
          .map(([provider, billed]) => ({ provider, tokens: tokenTotal(sumTokens(billed.map((call) => call.tokens))) }))
          .toSorted((left, right) => right.tokens - left.tokens)
          .at(0)?.provider,
      }))
      .toSorted((a, b) => tokenTotal(b.tokens) - tokenTotal(a.tokens));
    return [{ session, models, firstCallAt: DateTime.makeUnsafe(Math.min(...mine.map((call) => call.at))) }];
  });
};
