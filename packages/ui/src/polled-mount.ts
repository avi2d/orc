import { type Duration, Effect, Option, type Scope } from "effect";
import { freshOfStamped, polled, type Stamped } from "@avi2dg/orc-schema";
import { type Mounted, mountedOf, type Placed } from "./module";

export interface PolledReading<A> {
  readonly latest: Option.Option<Stamped<A>>;
  readonly refreshing: boolean;
}

export interface PolledMount<A, R> {
  readonly name: string;
  readonly key: string;
  readonly cadence: Duration.Input;
  readonly read: Effect.Effect<A, never, R>;
  readonly placed: (reading: () => PolledReading<A>) => Placed;
}

export const mountPolled = <A, R>(spec: PolledMount<A, R>): Effect.Effect<Mounted, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const poll = yield* polled(spec.read, spec.cadence);
    return yield* mountedOf({
      name: spec.name,
      key: spec.key,
      cadence: spec.cadence,
      reach: "none",
      read: Effect.gen(function* () {
        const latest = yield* poll.latest;
        yield* Effect.yieldNow;
        return { latest, refreshing: yield* poll.refreshing };
      }),
      pending: (reading) => Option.isNone(reading.latest),
      refreshing: (reading) => reading.refreshing,
      freshness: (reading) => freshOfStamped(Option.getOrUndefined(reading.latest)),
      placed: spec.placed,
    });
  });
