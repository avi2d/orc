import { DateTime } from "effect";
import type { CountedCall } from "../sessions/ledger";
import type { Session } from "../sessions/live";
import type { QuotaAvailability } from "../sources/quota";
import { tokenTotal, type Tokens, type Weighting, weightings } from "../sessions/tokens";

export const hourMillis = 3_600_000;

export interface Estimate {
  readonly share: number;
  readonly contributionPoints: number;
  readonly pointsPerHour: number;
}

interface Ranked {
  readonly priced: Estimate;
}

export interface Weighed {
  readonly window: number;
  readonly hour: number;
}

export const weighed = (calls: ReadonlyArray<CountedCall>, hourCutoff: number, weighting: Weighting): Weighed => {
  const weigh = weightings[weighting];
  return calls.reduce(
    (sum, call) => {
      const weight = weigh(call.tokens);
      return { window: sum.window + weight, hour: sum.hour + (call.at >= hourCutoff ? weight : 0) };
    },
    { window: 0, hour: 0 },
  );
};

export const estimate = (mine: Weighed, allWindow: number, usedPoints: number, spanHours: number): Estimate => {
  if (allWindow === 0) return { share: 0, contributionPoints: 0, pointsPerHour: 0 };
  const share = mine.window / allWindow;
  const pointsPerHour = spanHours > 0 ? ((mine.hour / spanHours) * usedPoints) / allWindow : 0;
  return { share, contributionPoints: share * usedPoints, pointsPerHour };
};

const isLive = (session: Session): boolean => session.identity.kind !== "ended";

// The trailing hour reaches back from now, boundary included, and only the rate's span is clamped to the cycle.
export const rateSpanHours = (start: number, resetsAt: number, now: number): number =>
  Math.max(0, Math.min(now, resetsAt) - Math.max(start, now - hourMillis)) / hourMillis;

interface Spend {
  readonly session: Session;
  readonly trailingHourTokens: Tokens;
  readonly priced: Estimate;
}

interface Gate {
  readonly burning: number;
  readonly fairPointsPerHour: number | null;
  readonly flagged: ReadonlySet<Session>;
  readonly exhaustsBeforeReset: boolean;
}

const effectiveExhaustsBeforeReset = (
  rows: ReadonlyArray<Spend>,
  sustainablePointsPerHour: number | null,
  verdict: boolean | null,
): boolean => {
  if (verdict !== null) return verdict;
  if (sustainablePointsPerHour === null) return false;
  if (sustainablePointsPerHour === 0) return true;
  const total = rows.filter((row) => isLive(row.session)).reduce((sum, row) => sum + row.priced.pointsPerHour, 0);
  return total > sustainablePointsPerHour;
};

export const spendGate = (
  rows: ReadonlyArray<Spend>,
  open: boolean,
  sustainablePointsPerHour: number | null,
  verdict: boolean | null,
): Gate => {
  const live = rows.filter((row) => isLive(row.session));
  const burning = live.filter((row) => tokenTotal(row.trailingHourTokens) > 0).length;
  const fair = sustainablePointsPerHour === null ? null : sustainablePointsPerHour / Math.max(burning, 1);
  const effective = effectiveExhaustsBeforeReset(rows, sustainablePointsPerHour, verdict);
  if (!open || fair === null || !effective)
    return { burning, fairPointsPerHour: fair, flagged: new Set(), exhaustsBeforeReset: effective };
  const over = live.filter((row) => row.priced.pointsPerHour > fair);
  return { burning, fairPointsPerHour: fair, flagged: new Set(over.map((row) => row.session)), exhaustsBeforeReset: effective };
};

export const verdictBeforeReset = (
  availability: ReadonlyArray<QuotaAvailability>,
  windowId: string,
  resetsAtMillis: number,
): boolean | null => {
  const runways = availability.flatMap((scope) => (scope.runway === undefined ? [] : [scope.runway]));
  if (runways.length === 0) return null;
  const runway = runways.find((candidate) => candidate.limitingWindowId === windowId);
  if (runway === undefined) return false;
  if (runway.status === "exhausted_now") return true;
  if (runway.status === "through_reset") return false;
  if (runway.status !== "projected_exhaustion" || runway.projectionConfidence === "early") return null;
  return runway.projectedExhaustedAt === undefined || DateTime.toEpochMillis(runway.projectedExhaustedAt) < resetsAtMillis;
};

export const byPricedShare = (a: Ranked, b: Ranked): number =>
  b.priced.share - a.priced.share || b.priced.pointsPerHour - a.priced.pointsPerHour;
