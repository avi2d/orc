import { Effect } from "effect"

export const supportsEveryAnswer: Effect.Effect<string> = Effect.succeed(JSON.stringify({ verdict: "supports" }))
