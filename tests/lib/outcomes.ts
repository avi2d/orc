import type { Outcome } from "@avi2dg/orc-schema";

export const valueOf = <A>(outcome: Outcome<A>): A => {
  if (outcome.kind !== "ok") throw new Error(`expected ok, got ${JSON.stringify(outcome)}`);
  return outcome.value;
};

export const issueOf = (outcome: Outcome<unknown>): string => {
  if (outcome.kind !== "invalid") throw new Error(`expected invalid, got ${JSON.stringify(outcome)}`);
  return outcome.issue;
};
