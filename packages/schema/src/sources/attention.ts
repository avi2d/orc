import { Context, Duration, Effect, Layer, Schema } from "effect";
import { CommandRunner } from "../command";
import { decodeJson } from "../decode";
import type { Outcome } from "../reading";
import { runDecoded } from "../source";

const AttentionItem = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  task: Schema.String,
  text: Schema.String,
  asked: Schema.String,
  owner: Schema.Literals(["decider", "user"]),
  ageSeconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  overdue: Schema.Boolean,
});

export type AttentionItem = typeof AttentionItem.Type;

const AttentionQueue = Schema.Struct({
  schema: Schema.Literal("orc.attention.v1"),
  at: Schema.String,
  items: Schema.Array(AttentionItem),
});

export type AttentionQueue = typeof AttentionQueue.Type;

const decodeAttentionQueue = decodeJson(AttentionQueue);

export class AttentionSource extends Context.Service<AttentionSource, { readonly read: Effect.Effect<Outcome<AttentionQueue>> }>()("orc-dash/AttentionSource") {}

const timeout = Duration.seconds(15);

export const attentionSourceLayer: Layer.Layer<AttentionSource, never, CommandRunner> = Layer.effect(
  AttentionSource,
  Effect.gen(function* () {
    const runner = yield* CommandRunner;
    return { read: Effect.provideService(runDecoded({ argv: ["orc", "attention", "--json"], timeout }, decodeAttentionQueue), CommandRunner, runner) };
  }),
);
