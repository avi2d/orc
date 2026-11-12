import { Console, Data, Effect, FileSystem, type Path } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { boardsVar } from "./chat-board"
import { chatToolNames, orcCommandVar } from "./chat-tools"
import { backlogPaths } from "../../entities/backlog/index"
import { type ProjectInstructions, readProjectInstructions, readFailure, providerEnvOf, readOrcConfig } from "../../shared/config/index"
import type { Command } from "../../shared/process/index"

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

interface LoadedInstructions extends ProjectInstructions {
  readonly text: string
}

const chatInstructions = (orcHome: string): Effect.Effect<ReadonlyArray<LoadedInstructions>, ChatError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const named = yield* readProjectInstructions(backlogPaths(orcHome + "/backlog").projects).pipe(
      Effect.mapError((error) => new ChatError({ message: "orc chat: " + error.file + ": " + error.detail }))
    )
    return yield* Effect.forEach(named, (entry) =>
      fs.readFileString(entry.file).pipe(
        Effect.map((text) => ({ ...entry, text })),
        Effect.mapError((error) => new ChatError({ message: "orc chat: cannot read the instructions file " + entry.file + ": " + readFailure(error) }))
      ))
  })

const rulesWords = (rules: ChatRules): string =>
  rules.kind === "loaded" ? "orc chat loaded the rules in " + rules.file : "orc chat found no rules at " + rules.file

const instructionsWords = (rules: ChatRules, instructions: ReadonlyArray<ProjectInstructions>): string =>
  instructions.length === 0
    ? ""
    : (rules.kind === "loaded" ? " and" : "; it loaded") + " the instructions for " + instructions.map((entry) => entry.project + " in " + entry.file).join(" and for ")

const instructionsPrompt = (entry: LoadedInstructions): string =>
  "The instructions file for the project " + entry.project + ", " + entry.file + ":\n\n" + entry.text

const chatLaunch = (orcHome: string, model: string, rules: ChatRules, instructions: ReadonlyArray<LoadedInstructions>, self: Command): ChatLaunch => ({
  command: [
    "pi",
    "--model",
    model,
    "--extension",
    chatToolsFile,
    "--tools",
    chatToolNames.join(","),
    ...(rules.kind === "loaded" ? ["--append-system-prompt", rules.file] : []),
    ...instructions.flatMap((entry) => ["--append-system-prompt", instructionsPrompt(entry)])
  ],
  env: { [orcCommandVar]: JSON.stringify(self), [boardsVar]: orcHome + "/boards" }
})

export const runChat = (
  orcHome: string,
  self: Command
): Effect.Effect<number, ChatError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const config = yield* readOrcConfig(orcHome).pipe(
      Effect.mapError((error) => new ChatError({ message: "orc chat: " + error.file + ": " + error.detail }))
    )
    const model = config.models?.orchestrator
    if (model === undefined) {
      return yield* new ChatError({ message: "orc chat needs models.orchestrator in " + config.file + ", the provider/model the chat runs on" })
    }
    const rules = yield* chatRules(orcHome)
    const instructions = yield* chatInstructions(orcHome)
    yield* Console.log(rulesWords(rules) + instructionsWords(rules, instructions))
    const launch = chatLaunch(orcHome, model, rules, instructions, self)
    const [program, ...args] = launch.command
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    // extendEnv lays this over the shell's environment, so the provider's env wins over an exported variable.
    const handle = yield* spawner.spawn(ChildProcess.make(program, args, { env: { ...providerEnvOf(config, model), ...launch.env }, extendEnv: true, stdin: "inherit", stdout: "inherit", stderr: "inherit" }))
    return yield* handle.exitCode
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PlatformError", (error) => Effect.fail(new ChatError({ message: "orc chat: cannot start pi: " + error.message })))
  )
