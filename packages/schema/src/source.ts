import { DateTime, Effect } from "effect";
import { type Command, CommandRunner } from "./command";
import { unreachable, type Outcome, type Reading } from "./reading";

export interface Source<A> {
  readonly read: Effect.Effect<Reading<A>>;
}

export const runDecoded = <A>(
  command: Command,
  decode: (stdout: string) => Outcome<A>,
): Effect.Effect<Outcome<A>, never, CommandRunner> =>
  Effect.gen(function* () {
    const runner = yield* CommandRunner;
    return yield* runner.run(command).pipe(
      Effect.map(decode),
      Effect.catchTag("CommandUnreachable", (failure) => Effect.succeed(unreachable(failure.reason))),
    );
  });

export const stamped = <A, R>(outcome: Effect.Effect<Outcome<A>, never, R>): Effect.Effect<Reading<A>, never, R> =>
  Effect.gen(function* () {
    const value = yield* outcome;
    const capturedAt = yield* DateTime.now;
    return { ...value, capturedAt };
  });

export const sourceOf = <A>(
  read: Effect.Effect<Reading<A>, never, CommandRunner>,
): Effect.Effect<Source<A>, never, CommandRunner> =>
  Effect.gen(function* () {
    const runner = yield* CommandRunner;
    return { read: Effect.provideService(read, CommandRunner, runner) };
  });
