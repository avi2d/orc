import { Duration } from "effect";
import type { Freshness } from "@tui-dash/schema";

const secondsOf = (cadence: Duration.Input): number => Duration.toMillis(Duration.fromInputUnsafe(cadence)) / 1000;

export const ageText = (seconds: number): string => {
  if (seconds < 60) return Math.max(0, Math.floor(seconds)) + "s";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m";
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h";
  return Math.floor(seconds / 86400) + "d";
};

export const everyText = (cadence: Duration.Input): string => "every " + ageText(secondsOf(cadence));

export const oldest = (...ats: ReadonlyArray<number | undefined>): number | undefined => {
  const known = ats.filter((at): at is number => at !== undefined);
  return known.length === 0 ? undefined : Math.min(...known);
};

export const savedText = (shown: Freshness | undefined, nowMillis: number): string =>
  shown?.kind !== "saved" ? "" : " \u00b7 saved " + ageText(Math.max(0, (nowMillis - shown.at) / 1000)) + " ago";
