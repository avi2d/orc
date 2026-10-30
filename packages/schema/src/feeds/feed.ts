import { Clock, Context, Deferred, Duration, Effect, Option, type Schema, type Scope } from "effect";

export interface Stamped<A> {
  readonly value: A;
  readonly at: number;
}

// at: when the source answered the reading on show, in epoch milliseconds.
export type Shown<A> =
  | { readonly kind: "live"; readonly value: A; readonly at: number }
  | { readonly kind: "saved"; readonly value: A; readonly at: number }
  | { readonly kind: "pending" };

export const shownValue = <A>(shown: Shown<A>): A | undefined => (shown.kind === "pending" ? undefined : shown.value);

export interface Freshness {
  readonly kind: "live" | "saved";
  readonly at: number;
}

export const shownAt = (shown: Shown<unknown>): Freshness | undefined => (shown.kind === "pending" ? undefined : { kind: shown.kind, at: shown.at });

export const savedAtOf = (fresh: ReadonlyArray<Freshness>): Freshness | undefined => {
  const saved = fresh.filter((entry) => entry.kind === "saved");
  return saved.length === 0 ? undefined : { kind: "saved", at: Math.min(...saved.map((entry) => entry.at)) };
};

export const freshOf = (shown: Shown<unknown>): ReadonlyArray<Freshness> => {
  const at = shownAt(shown);
  return at === undefined ? [] : [{ at: at.at, kind: at.kind }];
};

export const freshOfStamped = <A>(stamped: Stamped<A> | undefined): ReadonlyArray<Freshness> =>
  stamped === undefined ? [] : [{ at: stamped.at, kind: "live" }];

export const stampedNow = <A, R>(read: Effect.Effect<A, never, R>): Effect.Effect<Stamped<A>, never, R> =>
  Effect.flatMap(read, (value) => Effect.map(Clock.currentTimeMillis, (at) => ({ value, at })));

// print: each source is read once and waited for, and no saved copy stands in. live: sources read on their own clocks beside the paint.
export type ReadMode = "live" | "print";

export const ReadModeReference = Context.Reference<ReadMode>("@tui-dash/schema/ReadMode", { defaultValue: () => "print" });

export interface Polled<A> {
  // None until the source first answers.
  readonly latest: Effect.Effect<Option.Option<Stamped<A>>>;
  // The latest answer, waiting for the first.
  readonly settled: Effect.Effect<A>;
  // True while a read runs, so the box shows reading only while it refreshes.
  readonly refreshing: Effect.Effect<boolean>;
}

// A read started on the paint's tick waits out the paint and the tick after the read lands, so each source keeps its own clock instead.
// The clock starts on the first ask, so a source no panel shows is never read.
export const polled = <A, R>(read: Effect.Effect<A, never, R>, cadence: Duration.Input): Effect.Effect<Polled<A>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const provided = stampedNow(Effect.provideContext(read, yield* Effect.context<R>()));
    if ((yield* ReadModeReference) === "print") {
      const once = yield* Effect.cached(provided);
      return { latest: Effect.asSome(once), settled: Effect.map(once, (stamped) => stamped.value), refreshing: Effect.succeed(false) };
    }
    const scope = yield* Effect.scope;
    const first = yield* Deferred.make<A>();
    const cadenceMillis = Duration.toMillis(Duration.fromInputUnsafe(cadence));
    let landed = Option.none<Stamped<A>>();
    let inflight = false;
    let started = false;
    // Schedule.fixed waits a whole interval after the first read and then for the next boundary, so a read that outlasts it is held further back.
    const once = Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      const stamped = yield* Effect.ensuring(Effect.andThen(Effect.sync(() => {
        inflight = true;
      }), provided), Effect.sync(() => {
        inflight = false;
      }));
      landed = Option.some(stamped);
      yield* Deferred.succeed(first, stamped.value);
      const took = (yield* Clock.currentTimeMillis) - startedAt;
      yield* Effect.sleep(Duration.millis(Math.max(0, cadenceMillis - took)));
    });
    // Set on launch rather than in the fiber, so a read sampled right after the first ask still sees the run.
    const start = Effect.suspend(() => {
      if (started) return Effect.void;
      started = true;
      inflight = true;
      return Effect.asVoid(Effect.forkIn(Effect.forever(once), scope, { startImmediately: true }));
    });
    return {
      latest: Effect.andThen(start, Effect.sync(() => landed)),
      settled: Effect.andThen(start, Effect.suspend(() => (Option.isSome(landed) ? Effect.succeed(landed.value.value) : Deferred.await(first)))),
      refreshing: Effect.sync(() => inflight),
    };
  });

export interface SavedSlot<A> {
  readonly last: Effect.Effect<Option.Option<Stamped<A>>>;
  readonly keep: (value: A, at: number) => Effect.Effect<void>;
}

export interface SavedStore {
  readonly slot: <A>(key: string, codec: Schema.Codec<A, unknown>) => SavedSlot<A>;
}

export class SavedReadings extends Context.Service<SavedReadings, SavedStore>()("@tui-dash/schema/SavedReadings") {}

// A box shows its own source once it answers, and until then the saved copy with its age, so what is shown and the age it claims never part.
export const shownOf = <A>(fresh: Option.Option<Stamped<A>>, saved: Option.Option<Stamped<A>>): Shown<A> => {
  if (Option.isSome(fresh)) return { kind: "live", ...fresh.value };
  return Option.isSome(saved) ? { kind: "saved", value: saved.value.value, at: saved.value.at } : { kind: "pending" };
};

// A feed with several pollers refreshes while any of them runs.
export const refreshingOf = (polls: ReadonlyArray<{ readonly refreshing: Effect.Effect<boolean> }>): Effect.Effect<boolean> =>
  Effect.map(Effect.forEach(polls, (poll) => poll.refreshing), (flags) => flags.some((flag) => flag));

// Only a copy the source answered is kept, so a saved copy never claims an age younger than its reading.
export const savedStandIn = <A>(
  key: string,
  codec: Schema.Codec<A, unknown>,
): Effect.Effect<(fresh: Option.Option<Stamped<A>>) => Effect.Effect<Shown<A>>, never, SavedReadings> =>
  Effect.gen(function* () {
    const slot = (yield* SavedReadings).slot(key, codec);
    const last = yield* Effect.cached(slot.last);
    return (fresh) =>
      Effect.gen(function* () {
        if (Option.isSome(fresh)) yield* slot.keep(fresh.value.value, fresh.value.at);
        return shownOf(fresh, yield* last);
      });
  });
