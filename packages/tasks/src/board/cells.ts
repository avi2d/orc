import type { PlannedState, ShownState } from "@avi2dg/orc-schema";
import type { Tone } from "@avi2dg/orc-ui";

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
