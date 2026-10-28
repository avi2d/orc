import type { QuotaWindow } from "@tui-dash/schema";
import { shortLabel } from "./quota";

const hourSeconds = 3600;
const daySeconds = 86_400;

const lengthWords = (seconds: number): string => {
  if (seconds < 2 * daySeconds) {
    const hours = Math.round(seconds / hourSeconds);
    return hours === 1 ? "hour" : `${hours} hours`;
  }
  const days = Math.round(seconds / daySeconds);
  if (days === 7) return "week";
  if (days >= 28 && days <= 31) return "month";
  return `${days} days`;
};

const periodWord = /^(week|weekly|window|day|daily|month|monthly|session|usage|quota|rolling)$/i;

const modelOf = (label: string): string =>
  label
    .split(/[\s_]+/)
    .filter((word) => word !== "" && !periodWord.test(word))
    .join(" ")
    .toLowerCase();

// quota-axi and the saved profiles call one five-hour window session, rolling or 5h, so every window is named by its length.
export const windowName = (
  window: Pick<QuotaWindow, "kind" | "label" | "id" | "windowSeconds">,
  cycleSeconds: number | undefined,
): string => {
  const seconds = cycleSeconds ?? window.windowSeconds;
  if (seconds !== undefined) {
    const length = lengthWords(seconds);
    return window.kind === "model" ? `${modelOf(window.label)} ${length}`.trim() : length;
  }
  // A session, weekly or monthly window keeps its length when neither its pace nor its report names one.
  switch (window.kind) {
    case "session":
      return "5 hours";
    case "weekly":
      return "week";
    case "monthly":
      return "month";
    case "model":
    case "credits":
    case "unknown":
      return shortLabel(window);
  }
};

const savedLength = /^(\d+)\s*([hd])\b\s*(.*)$/i;

export const savedName = (label: string): string => {
  const match = savedLength.exec(label.trim());
  if (match === null) return shortLabel({ label, id: label });
  const seconds = Number(match[1]) * (match[2]?.toLowerCase() === "h" ? hourSeconds : daySeconds);
  const model = modelOf(match[3]);
  return model === "" ? lengthWords(seconds) : `${model} ${lengthWords(seconds)}`;
};
