import { DateTime } from "effect";
import type { Failed } from "@tui-dash/schema";
import { type Block, wrapParts } from "./layout";
import type { Tone } from "./palette";
import { ellipsize, type Line, span, widthOf } from "./text";

const sameDay = (left: DateTime.DateTime.PartsWithWeekday, right: DateTime.DateTime.PartsWithWeekday): boolean =>
  left.year === right.year && left.month === right.month && left.day === right.day;

const weekDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const clock = (at: DateTime.Utc, now: DateTime.Utc, zone: DateTime.TimeZone): string => {
  const parts = DateTime.toParts(DateTime.setZone(at, zone));
  const time = `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
  return sameDay(parts, DateTime.toParts(DateTime.setZone(now, zone))) ? time : `${weekDays[parts.weekDay] ?? ""} ${time}`;
};

export const countdown = (seconds: number): string => {
  if (!Number.isFinite(seconds)) return "";
  if (seconds <= 0) return "now";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) {
    const both = `${days}d ${hours}h`;
    return both.length > 6 ? `${days}d` : both;
  }
  if (hours > 0) {
    const both = `${hours}h ${minutes}m`;
    return both.length > 6 ? `${hours}h` : both;
  }
  return minutes > 0 ? `${minutes}m` : "<1m";
};

export const secondsBetween = (from: DateTime.DateTime, to: DateTime.DateTime): number =>
  (DateTime.toEpochMillis(to) - DateTime.toEpochMillis(from)) / 1000;

export const leftHealth = (percentLeft: number): Tone => {
  if (percentLeft >= 50) return "success";
  if (percentLeft >= 20) return "warning";
  return "error";
};

export const loadHealth = (percentUsed: number): Tone => {
  if (percentUsed < 60) return "success";
  if (percentUsed < 85) return "warning";
  return "error";
};

export const percent = (value: number): string => `${Math.round(value)}%`;

const gibibyte = 1024 ** 3;

export const gib = (bytes: number): string => `${(bytes / gibibyte).toFixed(1)}G`;

export const usedOfTotal = (used: number, total: number): string =>
  `${(used / gibibyte).toFixed(1)}/${(total / gibibyte).toFixed(1)}G`;

const failureText = (failure: Failed, subject?: string): string =>
  failure.kind === "unreachable"
    ? `\u2717${subject ? ` ${subject}` : ""} unreachable: ${failure.reason}`
    : `\u2717${subject ? ` ${subject}` : ""} invalid: ${failure.issue}`;

export const failureLine = (failure: Failed, width: number): Line => [span(ellipsize(failureText(failure), width), "error")];

const failureRoom = 3;

const splitter = new Intl.Segmenter();
const splitWide = (text: string, width: number): Array<string> => {
  if (widthOf(text) <= width) return [text];
  if (width < 1) return [text];
  const out: Array<string> = [];
  let cur = "";
  let used = 0;
  for (const { segment } of splitter.segment(text)) {
    const w = widthOf(segment);
    if (w > width) {
      if (cur !== "") out.push(cur);
      out.push(segment);
      cur = "";
      used = 0;
      continue;
    }
    if (used + w > width) {
      out.push(cur);
      cur = segment;
      used = w;
    } else {
      cur += segment;
      used += w;
    }
  }
  if (cur !== "") out.push(cur);
  return out;
};
export const failureLines = (failure: Failed, width: number, subject?: string, room: number = failureRoom): Block => {
  const lines = wrapParts(failureText(failure, subject).split(/\s+/), width, " ").flatMap((line) => splitWide(line, width));
  const kept = [...lines.slice(0, room - 1), lines.slice(room - 1).join(" ")].filter((text) => text !== "");
  return kept.map((text) => [span(widthOf(text) <= width ? text : ellipsize(text, width), "error")]);
};
