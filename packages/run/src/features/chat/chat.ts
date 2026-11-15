import { Console, Data, Effect, FileSystem, Path } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { boardsVar } from "./chat-board"
import { chatToolNames, orcCommandVar } from "./chat-tools"
import { backlogPaths } from "../../entities/backlog/index"
import { type LoadedInstructions, type OrcRules, readInstructions, readOrcRules } from "../../entities/orc-rules/index"
import { type ProjectInstructions, providerEnvOf, readOrcConfig } from "../../shared/config/index"
import type { Command } from "../../shared/process/index"

export class ChatError extends Data.TaggedError("ChatError")<{
  readonly message: string
}> {}

interface ChatLaunch {
  readonly command: Command
  readonly env: Record<string, string>
}

const chatToolsFile = import.meta.dir + "/chat-tools.ts"

const chatRules = (orcHome: string): Effect.Effect<OrcRules, ChatError, FileSystem.FileSystem> =>
  readOrcRules(orcHome).pipe(Effect.mapError((error) => new ChatError({ message: "orc chat: " + error.message })))

const chatInstructions = (orcHome: string): Effect.Effect<ReadonlyArray<LoadedInstructions>, ChatError, FileSystem.FileSystem | Path.Path> =>
  readInstructions(backlogPaths(orcHome + "/backlog").projects).pipe(Effect.mapError((error) => new ChatError({ message: "orc chat: " + error.message })))

const rulesWords = (rules: OrcRules): string =>
  rules.kind === "loaded" ? "orc chat loaded the rules in " + rules.file : "orc chat found no rules at " + rules.file

const instructionsWords = (rules: OrcRules, instructions: ReadonlyArray<ProjectInstructions>): string =>
  instructions.length === 0
    ? ""
    : (rules.kind === "loaded" ? " and" : "; it loaded") + " the instructions for " + instructions.map((entry) => entry.project + " in " + entry.file).join(" and for ")

const instructionsPrompt = (entry: LoadedInstructions): string =>
  "The instructions file for the project " + entry.project + ", " + entry.file + ":\n\n" + entry.text

const chatLaunch = (orcHome: string, model: string, rules: OrcRules, instructions: ReadonlyArray<LoadedInstructions>, self: Command, sessionFile: string | null): ChatLaunch => ({
  command: [
    "pi",
    "--model",
    model,
    "--extension",
    chatToolsFile,
    "--tools",
    chatToolNames.join(","),
    ...(rules.kind === "loaded" ? ["--append-system-prompt", rules.file] : []),
    ...instructions.flatMap((entry) => ["--append-system-prompt", instructionsPrompt(entry)]),
    ...(sessionFile === null ? [] : ["--session", sessionFile])
  ],
  env: { [orcCommandVar]: JSON.stringify(self), [boardsVar]: orcHome + "/boards" }
})

export const runChat = (
  orcHome: string,
  self: Command,
  sessionFile: string | null
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
    // Pi reads a value with no slash and no .jsonl as a session id to search for, and an absolute path is always a file.
    const absoluteSession = sessionFile === null ? null : (yield* Path.Path).resolve(sessionFile)
    const launch = chatLaunch(orcHome, model, rules, instructions, self, absoluteSession)
    const [program, ...args] = launch.command
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    // extendEnv lays this over the shell's environment, so the provider's env wins over an exported variable.
    const handle = yield* spawner.spawn(ChildProcess.make(program, args, { env: { ...providerEnvOf(config, model), ...launch.env }, extendEnv: true, stdin: "inherit", stdout: "inherit", stderr: "inherit" }))
    return yield* handle.exitCode
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PlatformError", (error) => Effect.fail(new ChatError({ message: "orc chat: cannot start pi: " + error.message })))
  )
