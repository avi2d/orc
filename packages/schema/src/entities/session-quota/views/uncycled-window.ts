import { noTokens, type Tokens } from "../contract/tokens";

interface UncycledFields {
  readonly cycleSeconds: undefined;
  readonly startsAt: null;
  readonly elapsedFraction: null;
  readonly pace: "unknown";
  readonly aheadOfPace: false;
  readonly pastFirstTenth: false;
  readonly exhaustsBeforeReset: false;
  readonly verdict: null;
  readonly sustainablePointsPerHour: null;
  readonly activeSessions: 0;
  readonly fairPointsPerHour: null;
  readonly observedCalls: 0;
  readonly observedTokens: Tokens;
  readonly unattributedPoints: number;
  readonly sessions: readonly [];
}

// With no cycle the window has no start to place a call in, so no session shares it and every used point stays unattributed.
export const uncycledFields = (usedPoints: number): UncycledFields => ({
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
  unattributedPoints: usedPoints,
  sessions: [],
});
