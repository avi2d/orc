import { Data } from "effect"

export class OrcRunError extends Data.TaggedError("OrcRunError")<{
  readonly message: string
}> {}
