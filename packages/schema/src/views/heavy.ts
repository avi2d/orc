import { heavyNotSetupReason, type HeavyCheck } from "../sources/heavy";
import type { Failed } from "../reading";

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

const minutesText = (minutes: number): string => `${minutes}m`;

const zshOrcMissing = /command not found: orc(?![\w-])/;

export const isHeavyNotSetup = (failure: Failed): boolean =>
  failure.kind === "unreachable" &&
  (failure.reason === heavyNotSetupReason ||
    failure.reason.includes("group is missing") ||
    failure.reason.includes("orc: command not found") ||
    zshOrcMissing.test(failure.reason) ||
    failure.reason.includes("orc: not found"));

export const heavySummary = (check: HeavyCheck): string => {
  const oldest = Math.max(0, ...check.queued.map((call) => call.ageMinutes));
  const queued = check.queued.length === 0 ? "0 queued" : `${check.queued.length} queued, oldest ${minutesText(oldest)}`;
  return [`${check.running.length}/${check.parallel} running`, queued, `${plural(check.bypassWeek, "bypass", "bypasses")} this week`].join(" \u00b7 ");
};
