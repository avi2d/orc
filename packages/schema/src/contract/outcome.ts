import { Schema } from "effect";

type OutcomeSchema<S extends Schema.Top> = Schema.Union<
  readonly [
    Schema.Struct<{ readonly kind: Schema.Literal<"ok">; readonly value: S }>,
    Schema.Struct<{ readonly kind: Schema.Literal<"unreachable">; readonly reason: Schema.String }>,
    Schema.Struct<{ readonly kind: Schema.Literal<"invalid">; readonly issue: Schema.String }>,
  ]
>;

export const outcomeOf = <S extends Schema.Top>(value: S): OutcomeSchema<S> =>
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal("ok"), value }),
    Schema.Struct({ kind: Schema.Literal("unreachable"), reason: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("invalid"), issue: Schema.String }),
  ]);
