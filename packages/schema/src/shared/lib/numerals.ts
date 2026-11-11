import { Schema, SchemaTransformation } from "effect";

const numeral = (pattern: RegExp) =>
  Schema.String.check(Schema.isPattern(pattern)).pipe(
    Schema.decodeTo(Schema.Finite, SchemaTransformation.numberFromString),
  );

export const CountText = numeral(/^\d+$/);

export const AmountText = numeral(/^\d+(?:\.\d+)?$/);
