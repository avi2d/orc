import { DateTime } from "effect";
import { type AlertRule, alertRules, type VerdictEntry } from "../contract/alert-verdicts";
import type { AlertEvent } from "../contract/alerts";

export interface RuleFire {
  readonly at: DateTime.Utc;
  readonly events: ReadonlyArray<AlertEvent>;
}

export interface RuleVerdict {
  readonly verdict: string;
  readonly event: AlertEvent;
  readonly firedAt: DateTime.Utc;
  readonly recordedAt: DateTime.Utc;
}

export interface RuleRecord {
  readonly rule: AlertRule;
  readonly fire: RuleFire | undefined;
  readonly verdict: RuleVerdict | undefined;
}

const eventKey = (event: AlertEvent): string => {
  switch (event.rule) {
    case "quota-pace":
      return `${event.account.provider} ${event.account.credentialKey ?? event.account.accountKey ?? ""} ${event.window}`;
    case "heavy-load":
      return event.machine;
    case "long-task":
      return `${event.machine} ${event.task.id} ${event.reason}`;
    case "nightly":
      return `${event.repo} ${event.workflow}`;
  }
};

// A listener writes each event once on arrival and again with its verdict, so one fire can sit on several lines.
const lastFire = (entries: ReadonlyArray<VerdictEntry>): RuleFire | undefined => {
  const latest = entries.reduce((most, entry) => Math.max(most, DateTime.toEpochMillis(entry.firedAt)), Number.NEGATIVE_INFINITY);
  const atLatest = entries.filter((entry) => DateTime.toEpochMillis(entry.firedAt) === latest);
  const first = atLatest.at(0);
  if (first === undefined) return undefined;
  const events = new Map(atLatest.map((entry) => [eventKey(entry.event), entry.event] as const));
  return { at: first.firedAt, events: [...events.values()] };
};

const lastVerdict = (entries: ReadonlyArray<VerdictEntry>): RuleVerdict | undefined => {
  const judged = entries.findLast((entry) => entry.verdict !== null);
  if (judged === undefined || judged.verdict === null) return undefined;
  return { verdict: judged.verdict, event: judged.event, firedAt: judged.firedAt, recordedAt: judged.recordedAt };
};

export const ruleRecords = (entries: ReadonlyArray<VerdictEntry>): ReadonlyArray<RuleRecord> =>
  alertRules.map((rule) => {
    const own = entries.filter((entry) => entry.event.rule === rule);
    return { rule, fire: lastFire(own), verdict: lastVerdict(own) };
  });

export const judgesFire = (verdict: RuleVerdict, fire: RuleFire): boolean =>
  DateTime.toEpochMillis(verdict.firedAt) === DateTime.toEpochMillis(fire.at);
