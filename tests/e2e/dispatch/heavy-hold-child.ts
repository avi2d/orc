import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { withHeavyHold } from "../../../packages/run/src/dispatch/heavy-hold"

const group = process.argv[2] ?? "orc-hold-test"

await Effect.runPromise(
  withHeavyHold(group, () => Effect.sleep("60 seconds")).pipe(Effect.provide(BunServices.layer))
)
