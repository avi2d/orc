import type { PlannedState, ShownState } from "@tui-dash/schema";
import type { Tone } from "@tui-dash/ui";

export const dash = "\u2013";

export type ListedState = ShownState | PlannedState;

export const stateTones: Readonly<Record<ListedState, Tone>> = {
  planned: "accent",
  held: "muted",
  working: "primary",
  waiting: "warning",
  parked: "muted",
  blocked: "error",
  done: "success",
  unknown: "muted",
};
