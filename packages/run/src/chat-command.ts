import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { Effect, Layer } from "effect"
import { ChatToolError } from "./chat-error"
import type { Command } from "./dispatch/runner"
import { capture } from "./dispatch/runner-exec"

export type Env = Readonly<Record<string, string | undefined>>

// Pi runs the chat tools under Node, and these Bun layers are the shared Node implementations.
export const fileSystemLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer)
const spawnerLayer = BunChildProcessSpawner.layer.pipe(Layer.provide(fileSystemLayer))

const definedEnv = (env: Env): Record<string, string> =>
  Object.fromEntries(Object.entries(env).flatMap(([name, value]) => value === undefined ? [] : [[name, value]]))

export const runCommand = (command: Command, stdin: string | null, env: Env): Effect.Effect<string, ChatToolError> =>
  capture(command, stdin, definedEnv(env)).pipe(
    Effect.provide(spawnerLayer),
    Effect.mapError((error) => new ChatToolError({ message: error.detail })),
    Effect.flatMap((finished) =>
      finished.exitCode === 0
        ? Effect.succeed(finished.stdout.trim())
        : Effect.fail(new ChatToolError({ message: finished.stderr.trim() || finished.stdout.trim() || command.join(" ") + " exited " + String(finished.exitCode) }))
    )
  )
