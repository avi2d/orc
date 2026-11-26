import { Effect } from "effect";
import { TestClock } from "effect/testing";

export const withTestClock = <A>(body: (clock: TestClock.TestClock) => Promise<A>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* TestClock.make();
        yield* clock.setTime(Date.now());
        return yield* Effect.promise(() => body(clock));
      }),
    ),
  );
