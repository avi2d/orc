import type { QuotaWindow } from "@tui-dash/schema";
import { leftHealth } from "./format";
import type { Tone } from "./palette";
import { ellipsize, type Line, span, widthOf } from "./text";

const hourSeconds = 3600;

// quota-axi labels a five-hour window "session", which reads as one of the rows, so a window is named by its cycle.
export const cycleName = (window: { readonly cycleSeconds: number }): string => {
  const hours = Math.round(window.cycleSeconds / hourSeconds);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
};

const periodWord = /^(week|window|day|month|session|usage|quota)$/i;

// quota-axi's row label: drop a trailing period word, keep the last hyphen part of a long label, cut to seven, and fall back to the id.
export const shortLabel = (window: Pick<QuotaWindow, "label" | "id">): string => {
  const words = window.label.split(/[\s_]+/).filter((word) => word !== "");
  const kept = words.length > 1 && periodWord.test(words.at(-1) ?? "") ? words.slice(0, -1) : words;
  const joined = kept.join(" ").toLowerCase();
  const tail = widthOf(joined) > 7 ? joined.slice(joined.lastIndexOf("-") + 1) : joined;
  return ellipsize(tail === "" ? window.id : tail, 7);
};

// quota-axi's bar resolution: half cells, never empty while any is left and never full while any is used.
const fillHalves = (percentLeft: number, width: number): number => {
  const bounded = Math.min(100, Math.max(0, percentLeft));
  const halves = Math.round((bounded / 100) * width * 2);
  if (bounded > 0 && halves === 0) return 1;
  if (bounded < 100 && halves === width * 2) return width * 2 - 1;
  return halves;
};

const barCell = (halvesLeft: number, fill: Tone): Line[number] => {
  if (halvesLeft >= 2) return span("━", fill);
  if (halvesLeft === 1) return span("╸", fill);
  return span("─", "subtle");
};

// The marker sits where the fill would end at an exactly linear burn, quota-axi's own timeRemainingPercent.
export const quotaBar = (percentLeft: number, markerPercent: number | undefined, width: number): Line => {
  const halves = fillHalves(percentLeft, width);
  const fill = leftHealth(percentLeft);
  const marker =
    markerPercent === undefined ? undefined : Math.min(width - 1, Math.max(0, Math.round((markerPercent / 100) * width)));
  return Array.from({ length: width }, (_, cell) =>
    cell === marker ? span("┃", "accent") : barCell(halves - cell * 2, fill),
  );
};
