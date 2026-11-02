import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { Data, Effect, Layer, Schema } from "effect"
import { capture } from "./dispatch/runner"

export const orcCommandVar = "ORC_CHAT_ORC"

export class ChatToolError extends Data.TaggedError("ChatToolError")<{
  readonly message: string
}> {}

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

interface ChatToolHost {
  readonly registerTool: (tool: ChatTool) => void
}

type Env = Readonly<Record<string, string | undefined>>

// Pi runs this file under Node, and these Bun layers are the shared Node implementations.
const spawnerLayer = BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)))

const definedEnv = (env: Env): Record<string, string> =>
  Object.fromEntries(Object.entries(env).flatMap(([name, value]) => value === undefined ? [] : [[name, value]]))

const OrcCommand = Schema.fromJsonString(Schema.NonEmptyArray(Schema.String))

const AddTaskInput = Schema.Struct({
  project: Schema.String.annotate({ description: "The project the task is for, as the backlog's project list names it" }),
  task: Schema.String.annotate({ description: "The task as markdown, whose first line is its title" }),
  machine: Schema.optionalKey(Schema.String.annotate({ description: "The one machine the task may run on" })),
  dependsOn: Schema.optionalKey(Schema.Array(Schema.String).annotate({ description: "The ids of the tasks that must close done before this one starts" }))
})

// Effect writes an empty struct as {"not":{"type":"null"}}, and Pi takes only an object schema.
const noParameters = { type: "object", properties: {}, additionalProperties: false } as const

const runOrc = (env: Env, args: ReadonlyArray<string>, stdin: string | null): Effect.Effect<string, ChatToolError> =>
  Effect.gen(function*() {
    const command = yield* Schema.decodeEffect(OrcCommand)(env[orcCommandVar] ?? "").pipe(
      Effect.mapError(() => new ChatToolError({ message: "the orc chat tools run only inside orc chat, which names its orc in " + orcCommandVar }))
    )
    const finished = yield* capture([...command, ...args], stdin, definedEnv(env)).pipe(
      Effect.provide(spawnerLayer),
      Effect.mapError((error) => new ChatToolError({ message: error.detail }))
    )
    if (finished.exitCode !== 0) {
      return yield* new ChatToolError({ message: finished.stderr.trim() || "orc " + args.join(" ") + " exited " + String(finished.exitCode) })
    }
    return finished.stdout.trim()
  })

const textResult = (text: string): TextResult => ({ content: [{ type: "text", text }], details: undefined })

const decodeInput = <A>(schema: Schema.Decoder<A>, tool: string, params: unknown): Effect.Effect<A, ChatToolError> =>
  Schema.decodeUnknownEffect(schema)(params, { onExcessProperty: "error" }).pipe(
    Effect.mapError((error) => new ChatToolError({ message: tool + " takes " + error.message }))
  )

export const chatTools = (env: Env): ReadonlyArray<ChatTool> => [
  {
    name: "orc_backlog_add",
    label: "Add to the orc backlog",
    description: "Adds one task to the orc backlog through orc backlog add, and returns the line orc prints, which names the new task's id.",
    parameters: Schema.toJsonSchemaDocument(AddTaskInput).schema,
    execute: (_toolCallId, params) =>
      Effect.runPromise(
        decodeInput(AddTaskInput, "orc_backlog_add", params).pipe(
          Effect.flatMap((input) =>
            runOrc(env, [
              "backlog",
              "add",
              input.project,
              "-",
              ...(input.machine === undefined ? [] : ["--machine", input.machine]),
              ...(input.dependsOn ?? []).flatMap((id) => ["--depends-on", id])
            ], input.task)
          ),
          Effect.map(textResult)
        )
      )
  },
  {
    name: "orc_backlog",
    label: "Read the orc backlog",
    description: "Returns orc backlog --json: every new, taken and closed task with its project, machine, outcome and PR, the project list, and the room on each machine.",
    parameters: noParameters,
    execute: () => Effect.runPromise(runOrc(env, ["backlog", "--json"], null).pipe(Effect.map(textResult)))
  }
]

export const chatToolNames: ReadonlyArray<string> = chatTools({}).map((tool) => tool.name)

export default function registerChatTools(pi: ChatToolHost): void {
  for (const tool of chatTools(process.env)) {
    pi.registerTool(tool)
  }
}
