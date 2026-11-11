import { Clock, Duration, Effect, Fiber, Option, type Scope } from "effect";
import { type Stamped, stampedNow } from "./feed";

export interface BackgroundTuning {
  // A shorter wait paints sooner, so a screen that combines many reads sets its own.
  readonly patience?: Duration.Input;
  // A read started this recently is not started again, so the reads keep their own cadence whatever the paint's.
  readonly revalidate?: Duration.Input | undefined;
}

// A read slower than a refresh would hold every other panel back, so it runs on its own fiber and the panel shows its last finished result.
// Without a revalidate window, the call that collects a read that outlasted the patience starts no new read.
// A read still running when the scope closes is interrupted, so quitting is not held up by it.
export interface BackgroundPoll<I, A, R> {
  readonly read: (input: I) => Effect.Effect<Option.Option<Stamped<A>>, never, R>;
  // True while the run fiber answers, so the box shows reading only while it refreshes.
  readonly refreshing: Effect.Effect<boolean>;
}

export const stampedInBackground = <I, A, R>(
  work: (input: I) => Effect.Effect<A, never, R>,
  patience: Duration.Input,
  options?: Pick<BackgroundTuning, "revalidate">,
): Effect.Effect<BackgroundPoll<I, A, R>, never, Scope.Scope> =>
  Effect.map(Effect.scope, (scope) => {
    let latest = Option.none<Stamped<A>>();
    let startedAt = Number.NEGATIVE_INFINITY;
    let running: Fiber.Fiber<Stamped<A>> | undefined;
    const revalidateMillis = options?.revalidate === undefined ? undefined : Duration.toMillis(Duration.fromInputUnsafe(options.revalidate));
    const keep = (stamped: Stamped<A>) =>
      Effect.sync(() => {
        latest = Option.some(stamped);
      });
    const read = (input: I) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const landed = running?.pollUnsafe() !== undefined;
        if (landed) running = undefined;
        const fresh = revalidateMillis === undefined ? landed : now - startedAt < revalidateMillis;
        if (running === undefined && !fresh) {
          startedAt = now;
          running = yield* Effect.forkIn(Effect.tap(stampedNow(work(input)), keep), scope);
        }
        if (running === undefined) return latest;
        const finished = yield* Fiber.await(running).pipe(Effect.timeoutOption(patience));
        if (Option.isSome(finished)) running = undefined;
        return latest;
      });
    return { read, refreshing: Effect.sync(() => running !== undefined && running.pollUnsafe() === undefined) };
  });

export const inBackground = <I, A, R>(
  work: (input: I) => Effect.Effect<A, never, R>,
  patience: Duration.Input,
  options?: Pick<BackgroundTuning, "revalidate">,
): Effect.Effect<(input: I) => Effect.Effect<Option.Option<A>, never, R>, never, Scope.Scope> =>
  Effect.map(stampedInBackground(work, patience, options), (poll) => (input: I) => Effect.map(poll.read(input), Option.map((stamped) => stamped.value)));
