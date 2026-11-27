import { noTokens } from "../contract/tokens";
import type { WindowView } from "./session-quota";

export type WindowHead = Pick<WindowView, "id" | "label" | "kind" | "source" | "resetsAt" | "usedPoints" | "leftPoints" | "otherCycle">;

// With no cycle the window has no start to place a call in, so no session shares it and every used point stays unattributed.
export const uncycledWindow = (head: WindowHead): WindowView => ({
  ...head,
  cycleSeconds: undefined,
  startsAt: null,
  elapsedFraction: null,
  pace: "unknown",
  aheadOfPace: false,
  pastFirstTenth: false,
  exhaustsBeforeReset: false,
  verdict: null,
  sustainablePointsPerHour: null,
  activeSessions: 0,
  fairPointsPerHour: null,
  observedCalls: 0,
  observedTokens: noTokens,
  unattributedPoints: head.usedPoints,
  sessions: [],
});
