import { Console, Data, Effect, FileSystem } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { boardsVar } from "./chat-board"
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

type ChatRules = { readonly kind: "loaded"; readonly file: string } | { readonly kind: "none"; readonly file: string }

const chatRules = (orcHome: string): Effect.Effect<ChatRules, ChatError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const file = orcHome + "/orchestrator.md"
    const fs = yield* FileSystem.FileSystem
    const info = yield* fs.stat(file).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
      Effect.mapError((error) => new ChatError({ message: "orc chat: " + file + ": " + error.message }))
    )
    return info !== null && info.type === "File" ? { kind: "loaded", file } : { kind: "none", file }
  })

const rulesLine = (rules: ChatRules): string =>
  rules.kind === "loaded" ? "orc chat loaded the rules in " + rules.file : "orc chat found no rules at " + rules.file

const chatLaunch = (orcHome: string, model: string, rules: ChatRules, self: Command): ChatLaunch => ({
  command: [
    "pi",
    "--model",
    model,
    "--extension",
    chatToolsFile,
    "--tools",
    chatToolNames.join(","),
    ...(rules.kind === "loaded" ? ["--append-system-prompt", rules.file] : [])
  ],
  env: { [orcCommandVar]: JSON.stringify(self), [boardsVar]: orcHome + "/boards" }
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
    const rules = yield* chatRules(orcHome)
    yield* Console.log(rulesLine(rules))
    const launch = chatLaunch(orcHome, model, rules, self)
    const [program, ...args] = launch.command
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make(program, args, { env: launch.env, extendEnv: true, stdin: "inherit", stdout: "inherit", stderr: "inherit" }))
    return yield* handle.exitCode
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PlatformError", (error) => Effect.fail(new ChatError({ message: "orc chat: cannot start pi: " + error.message })))
  )
