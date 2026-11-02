import { Data, Effect, FileSystem } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { chatToolNames, orcCommandVar } from "./chat-tools"
import type { Command } from "./dispatch/runner"
import { readOrcConfig } from "./orc-config"

export class ChatError extends Data.TaggedError("ChatError")<{
  readonly message: string
}> {}

interface ChatLaunch {
  readonly command: Command
  readonly env: Record<string, string>
}

const chatToolsFile = import.meta.dir + "/chat-tools.ts"

const chatLaunch = (model: string, self: Command): ChatLaunch => ({
  command: ["pi", "--model", model, "--extension", chatToolsFile, "--tools", chatToolNames.join(",")],
  env: { [orcCommandVar]: JSON.stringify(self) }
})

export const runChat = (orcHome: string, self: Command): Effect.Effect<number, ChatError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const config = yield* readOrcConfig(orcHome).pipe(
      Effect.mapError((error) => new ChatError({ message: "orc chat: " + error.file + ": " + error.detail }))
    )
    const model = config.models?.orchestrator
    if (model === undefined) {
      return yield* new ChatError({ message: "orc chat needs models.orchestrator in " + config.file + ", the provider/model the chat runs on" })
    }
    const launch = chatLaunch(model, self)
    const [program, ...args] = launch.command
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make(program, args, { env: launch.env, extendEnv: true, stdin: "inherit", stdout: "inherit", stderr: "inherit" }))
    return yield* handle.exitCode
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PlatformError", (error) => Effect.fail(new ChatError({ message: "orc chat: cannot start pi: " + error.message })))
  )
