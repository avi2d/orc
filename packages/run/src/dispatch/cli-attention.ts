import { type Effect, type FileSystem } from "effect"
import type { DispatchArgs } from "./args"
import { attentionText } from "./attention-view"
import type { BacklogError } from "./backlog-write"

export const attentionNow = (
  args: Extract<DispatchArgs, { readonly kind: "ShowAttention" }>,
  root: string
): Effect.Effect<string, BacklogError, FileSystem.FileSystem> =>
  attentionText(args.json, root)
