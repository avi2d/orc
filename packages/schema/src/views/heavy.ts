import type { HeavyCheck } from "../sources/heavy";

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

const minutesText = (minutes: number): string => (minutes === 0 ? "under 1m" : `${minutes}m`);

export const heavySummary = (check: HeavyCheck): string => {
  const oldest = Math.max(0, ...check.queued.map((call) => call.ageMinutes));
  const queued = check.queued.length === 0 ? "0 queued" : `${check.queued.length} queued, oldest ${minutesText(oldest)}`;
  return [`${check.running.length}/${check.parallel} running`, queued, `${plural(check.bypassWeek, "bypass", "bypasses")} this week`].join(" \u00b7 ");
};
