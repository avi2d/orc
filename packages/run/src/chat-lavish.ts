import { Effect, Schema } from "effect"
import { type Env, runCommand } from "./chat-command"
import { ChatToolError } from "./chat-error"
import { scalar, table } from "./toon"

export interface BoardPrompt {
  readonly tag: string
  readonly text: string
  readonly data: unknown
}

export type BoardPoll =
  | { readonly kind: "feedback"; readonly prompts: ReadonlyArray<BoardPrompt> }
  | { readonly kind: "waiting" }
  | { readonly kind: "closed"; readonly status: string }

export interface BoardLauncher {
  readonly open: (file: string) => Effect.Effect<string, ChatToolError>
  readonly poll: (file: string) => Effect.Effect<BoardPoll, ChatToolError>
  readonly reply: (file: string, text: string) => Effect.Effect<void, ChatToolError>
  readonly end: (file: string) => Effect.Effect<void, ChatToolError>
}

const contextMarker = "\n\nContext data:\n"

const decodeData = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

const promptData = (prompt: string): Effect.Effect<unknown> => {
  const cut = prompt.indexOf(contextMarker)
  return cut === -1 ? Effect.succeed(null) : decodeData(prompt.slice(cut + contextMarker.length)).pipe(Effect.orElseSucceed(() => null))
}

const promptsOf = (output: string): Effect.Effect<ReadonlyArray<BoardPrompt>> =>
  Effect.forEach(table(output, "prompts"), (row) =>
    promptData(row.get("prompt") ?? "").pipe(Effect.map((data) => ({ tag: row.get("tag") ?? "", text: row.get("text") ?? "", data }))))

const lavish = (args: ReadonlyArray<string>, env: Env): Effect.Effect<string, ChatToolError> =>
  runCommand(["lavish-axi", ...args], null, env)

export const lavishLauncher = (env: Env): BoardLauncher => ({
  open: (file) =>
    lavish([file, "--no-open", "--reopen"], env).pipe(
      Effect.filterOrFail((output) => scalar(output, "url") !== "", (output) => new ChatToolError({ message: "lavish-axi opened no session for " + file + ": " + output })),
      Effect.map((output) => scalar(output, "url"))
    ),
  poll: (file) =>
    lavish(["poll", file], env).pipe(
      Effect.flatMap((output): Effect.Effect<BoardPoll> => {
        const status = scalar(output, "status")
        if (status === "feedback") {
          return promptsOf(output).pipe(Effect.map((prompts) => ({ kind: "feedback", prompts })))
        }
        return Effect.succeed(status === "waiting" ? { kind: "waiting" } : { kind: "closed", status: status === "" ? "no status" : status })
      })
    ),
  reply: (file, text) => lavish(["reply", file, "--agent-reply", text], env).pipe(Effect.asVoid),
  end: (file) => lavish(["end", file], env).pipe(Effect.asVoid)
})
