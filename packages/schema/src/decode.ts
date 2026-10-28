import { Option, Result, Schema } from "effect";
import type { Outcome } from "./reading";

export type Decoded<A> = Exclude<Outcome<A>, { readonly kind: "unreachable" }>;

export const decoded = <A>(value: A): Decoded<A> => ({ kind: "ok", value });

export const rejected = (issue: string): Decoded<never> => ({ kind: "invalid", issue });

export const decodeValue =
  <A>(schema: Schema.Decoder<A>) =>
  (input: unknown): Decoded<A> => {
    const result = Schema.decodeUnknownResult(schema)(input, { errors: "all" });
    return Result.isSuccess(result) ? decoded(result.success) : rejected(result.failure.message);
  };

export const decodeJson =
  <A>(schema: Schema.Decoder<A>, scrubbed: (parsed: unknown) => unknown = (parsed) => parsed) =>
  (text: string): Decoded<A> => {
    const parsed = Result.try((): unknown => JSON.parse(text));
    return Result.isSuccess(parsed) ? decodeValue(schema)(scrubbed(parsed.success)) : rejected("the output is not JSON");
  };

// A torn or foreign line carries nothing to count, so it is skipped rather than failing the file.
export const recordLines = <A>(schema: Schema.Decoder<A>): ((text: string) => ReadonlyArray<A>) => {
  const decodeRecord = Schema.decodeUnknownOption(schema);
  return (text) =>
    text.split("\n").flatMap((line) => {
      if (line.trim() === "") return [];
      const parsed = Result.try((): unknown => JSON.parse(line));
      if (Result.isFailure(parsed)) return [];
      return Option.match(decodeRecord(parsed.success), { onNone: () => [], onSome: (record) => [record] });
    });
};

export const flatMapDecoded = <A, B>(value: Decoded<A>, f: (a: A) => Decoded<B>): Decoded<B> =>
  value.kind === "ok" ? f(value.value) : value;
