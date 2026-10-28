import { DateTime, Effect, Option, type Scope } from "effect";
import { CiCodec, type CiReport, CiRuns, polled, type Reading, type SavedReadings, savedStandIn, type Shown, slowReadsCadence, type Stamped } from "@tui-dash/schema";

// unset: no repository to watch is configured, so the box says so rather than reading.
export type CiShown = { readonly kind: "unset" } | Shown<Reading<CiReport>>;

const unset: CiShown = { kind: "unset" };

const capturedStamped = (fresh: Option.Option<Stamped<Reading<CiReport>>>): Option.Option<Stamped<Reading<CiReport>>> =>
  Option.map(fresh, (answer) => ({ value: answer.value, at: DateTime.toEpochMillis(answer.value.capturedAt) }));

export const ciFeed: Effect.Effect<{ readonly read: Effect.Effect<CiShown>; readonly refreshing: Effect.Effect<boolean> }, never, CiRuns | SavedReadings | Scope.Scope> = Effect.gen(function* () {
  const runs = yield* CiRuns;
  if (Option.isNone(runs)) return { read: Effect.succeed(unset), refreshing: Effect.succeed(false) };
  const poll = yield* polled(runs.value.read, slowReadsCadence);
  const standIn = yield* savedStandIn("ci", CiCodec);
  return { read: Effect.flatMap(poll.latest, (fresh) => standIn(capturedStamped(fresh))), refreshing: poll.refreshing };
});
