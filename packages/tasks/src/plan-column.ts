import type { ProjectRow } from "@tui-dash/schema";
import { type Line, span, type Tone } from "@tui-dash/ui";
import { dash, stateTones } from "./cells";

export const planWidth = 4;

type PlanFigures = Pick<ProjectRow, "ready" | "held">;

export const planText = (row: PlanFigures): string => {
  if (row.held === 0) return row.ready === 0 ? dash : String(row.ready);
  return row.ready === 0 ? `+${row.held}` : `${row.ready}+${row.held}`;
};

export const planSpans = (row: PlanFigures): Line => {
  const text = planText(row);
  const plus = text.indexOf("+");
  const ready = plus === -1 ? text : text.slice(0, plus);
  const readyTone: Tone = row.ready === 0 ? "foreground" : stateTones.planned;
  return [...(ready === "" ? [] : [span(ready, readyTone)]), ...(plus === -1 ? [] : [span(text.slice(plus), stateTones.held)])];
};
