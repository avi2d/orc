import type { DateTime } from "effect";

export type Outcome<A> =
  | { readonly kind: "ok"; readonly value: A }
  | { readonly kind: "unreachable"; readonly reason: string }
  | { readonly kind: "invalid"; readonly issue: string };

export type Failed = Exclude<Outcome<never>, { readonly kind: "ok" }>;

export type Reading<A> = Outcome<A> & { readonly capturedAt: DateTime.Utc };

export const ok = <A>(value: A): Outcome<A> => ({ kind: "ok", value });

export const unreachable = (reason: string): Failed => ({ kind: "unreachable", reason });

const invalid = (issue: string): Failed => ({ kind: "invalid", issue });

export const failureOf = (outcome: Failed): Failed =>
  outcome.kind === "unreachable" ? unreachable(outcome.reason) : invalid(outcome.issue);

export const mapOutcome = <A, B>(outcome: Outcome<A>, f: (value: A) => B): Outcome<B> =>
  outcome.kind === "ok" ? ok(f(outcome.value)) : failureOf(outcome);

const flatMapOutcome = <A, B>(outcome: Outcome<A>, f: (value: A) => Outcome<B>): Outcome<B> =>
  outcome.kind === "ok" ? f(outcome.value) : failureOf(outcome);

export const zipOutcomes = <A, B, C>(left: Outcome<A>, right: Outcome<B>, f: (a: A, b: B) => C): Outcome<C> =>
  flatMapOutcome(left, (a) => mapOutcome(right, (b) => f(a, b)));
