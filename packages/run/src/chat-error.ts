import { Data } from "effect"

export class ChatToolError extends Data.TaggedError("ChatToolError")<{
  readonly message: string
}> {}
