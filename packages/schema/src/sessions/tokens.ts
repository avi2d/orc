import { Schema } from "effect";

export const Tokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
});

export type Tokens = typeof Tokens.Type;

export const noTokens: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const addTokens = (left: Tokens, right: Tokens): Tokens => ({
  input: left.input + right.input,
  output: left.output + right.output,
  cacheRead: left.cacheRead + right.cacheRead,
  cacheWrite: left.cacheWrite + right.cacheWrite,
});

export const sumTokens = (all: ReadonlyArray<Tokens>): Tokens => all.reduce(addTokens, noTokens);

export const tokenTotal = (tokens: Tokens): number => tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;

// Anthropic's API list price of each kind against base input, a proxy that ranks spend and never the subscription meter.
export const priceRatios = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 2 } as const satisfies Record<
  keyof Tokens,
  number
>;

const priced = (tokens: Tokens): number =>
  tokens.input * priceRatios.input +
  tokens.output * priceRatios.output +
  tokens.cacheRead * priceRatios.cacheRead +
  tokens.cacheWrite * priceRatios.cacheWrite;

export const weightings = { raw: tokenTotal, priced } as const satisfies Record<string, (tokens: Tokens) => number>;

export type Weighting = keyof typeof weightings;
