import { Effect, Schema } from "effect"
import { type Env, runCommand } from "./chat-command"
import { ChatToolError } from "./chat-error"

export const orcCommandVar = "ORC_CHAT_ORC"

interface TextResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>
  readonly details: undefined
}

export interface ChatTool {
  readonly name: string
  readonly label: string
  readonly description: string
  readonly parameters: unknown
  readonly execute: (toolCallId: string, params: unknown) => Promise<TextResult>
}

const OrcCommand = Schema.fromJsonString(Schema.NonEmptyArray(Schema.String))

export const runOrc = (env: Env, args: ReadonlyArray<string>, stdin: string | null): Effect.Effect<string, ChatToolError> =>
  Effect.gen(function*() {
    const command = yield* Schema.decodeEffect(OrcCommand)(env[orcCommandVar] ?? "").pipe(
      Effect.mapError(() => new ChatToolError({ message: "the orc chat tools run only inside orc chat, which names its orc in " + orcCommandVar }))
    )
    return yield* runCommand([...command, ...args], stdin, env)
  })

export const textResult = (text: string): TextResult => ({ content: [{ type: "text", text }], details: undefined })

export const decodeInput = <A>(schema: Schema.Decoder<A>, tool: string, params: unknown): Effect.Effect<A, ChatToolError> =>
  Schema.decodeUnknownEffect(schema)(params, { onExcessProperty: "error" }).pipe(
    Effect.mapError((error) => new ChatToolError({ message: tool + " takes " + error.message }))
  )

export const runTool = <A>(schema: Schema.Decoder<A>, name: string, params: unknown, env: Env, args: (input: A) => ReadonlyArray<string>): Promise<TextResult> =>
  Effect.runPromise(
    decodeInput(schema, name, params).pipe(
      Effect.flatMap((input) => runOrc(env, args(input), null)),
      Effect.map(textResult)
    )
  )
