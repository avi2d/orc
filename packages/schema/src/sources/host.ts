import { Effect, Schema } from "effect";
import type { Command, CommandRunner } from "../command";
import { type Failed, failureOf, ok, type Outcome } from "../reading";
import { runDecoded, sourceOf, stamped, type Source } from "../source";
import { AmountText } from "./numerals";

export const LoadAverage = Schema.Tuple([AmountText, AmountText, AmountText]);

export const probe = <A>(
  command: Command,
  decode: (stdout: string) => Outcome<A>,
): Effect.Effect<A, Failed, CommandRunner> =>
  runDecoded(command, decode).pipe(
    Effect.flatMap((outcome) => (outcome.kind === "ok" ? Effect.succeed(outcome.value) : Effect.fail(failureOf(outcome)))),
  );

export const hostSource = <A>(
  probes: Effect.Effect<A, Failed, CommandRunner>,
): Effect.Effect<Source<A>, never, CommandRunner> =>
  sourceOf(stamped(Effect.match(probes, { onFailure: (failure): Outcome<A> => failure, onSuccess: ok })));
