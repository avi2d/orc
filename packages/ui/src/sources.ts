import type { DateTime } from "effect";
import type { AccountJoin, HarvestOrigin, WindowSource } from "@tui-dash/schema";
import { countdown, secondsBetween } from "./format";

const minuteSeconds = 60;

const harvestName = (origin: HarvestOrigin): string => {
  if (origin.harness === "codex") return "codex rollout";
  if (origin.via === "statusline") return "claude code statusline";
  return origin.via === "headless" ? "claude code headless" : "claude code log";
};

export const agoWords = (seconds: number): string => (seconds < minuteSeconds ? "just now" : `${countdown(seconds)} ago`);

export const sourceWords = (source: WindowSource, now: DateTime.Utc): string =>
  source.kind === "quota-axi"
    ? `quota-axi ${agoWords(secondsBetween(source.readAt, now))}`
    : `${harvestName(source)} ${agoWords(secondsBetween(source.observedAt, now))}`;

export const joinWords = (joins: ReadonlyArray<AccountJoin>): string | undefined => {
  if (joins.length === 0) return undefined;
  if (joins.every((join) => join.kind === "credential-key")) return "joined by credential key";
  return joins.some((join) => join.kind === "default-account") ? "assumed the default login" : "assumed the only login";
};
