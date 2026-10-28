import { DateTime } from "effect";
import type { QuotaPaceEvent } from "../contract/alerts";
import type { ComposedSessionQuotaReport } from "../contract/composed-session-quota";
import type { Outcome } from "../reading";
import { type Episode, episodeStep, type Stepped } from "./episode";

export type QuotaPaceState = ReadonlyMap<string, Episode>;

export const quotaPaceStart: QuotaPaceState = new Map();

type ComposedWindow = ComposedSessionQuotaReport["windows"][number];

type Account = ComposedWindow["account"];

const accountKey = (account: Account): string => `${account.provider} ${account.credentialKey ?? account.accountKey ?? ""}`;

const windowKey = (window: ComposedWindow): string => `${accountKey(window.account)} ${window.id}`;

const eventOf = (report: ComposedSessionQuotaReport, window: ComposedWindow, at: DateTime.Utc): QuotaPaceEvent => ({
  schemaVersion: 1,
  rule: "quota-pace",
  at: DateTime.formatIso(at),
  account: window.account,
  window: window.id,
  windowLabel: window.label,
  leftPoints: window.leftPoints,
  elapsedFraction: window.elapsedFraction,
  resetsAt: window.resetsAt,
  flags: report.flags.filter((flag) => flag.window === window.id && accountKey(flag.account) === accountKey(window.account)),
});

// An alert fires while the window threatens its reset or holds a flag, so a burst with neither stays quiet.
// A window the report leaves out, such as one whose account failed to read, keeps its episode, since only a quiet window ends one.
const threatens = (report: ComposedSessionQuotaReport, window: ComposedWindow): boolean =>
  window.gate.open &&
  (window.exhaustsBeforeReset === true ||
    report.flags.some((flag) => flag.window === window.id && accountKey(flag.account) === accountKey(window.account)));

export const quotaPaceStep = (
  state: QuotaPaceState,
  sample: Outcome<ComposedSessionQuotaReport>,
  now: DateTime.Utc,
): Stepped<QuotaPaceState, QuotaPaceEvent> => {
  if (sample.kind !== "ok") return { state, events: [] };
  const next = new Map(state);
  const events: Array<QuotaPaceEvent> = [];
  for (const window of sample.value.windows) {
    const key = windowKey(window);
    const step = episodeStep(next.get(key), threatens(sample.value, window) ? "over" : "under", DateTime.toEpochMillis(now), 0);
    if (step.episode === undefined) next.delete(key);
    else next.set(key, step.episode);
    if (step.fire) events.push(eventOf(sample.value, window, now));
  }
  return { state: next, events };
};
