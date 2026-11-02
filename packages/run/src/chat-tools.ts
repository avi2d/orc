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

export interface ChatSession {
  readonly tools: ReadonlyArray<ChatTool>
  readonly postClosed: () => Promise<void>
}

interface ChatHost {
  readonly registerTool: (tool: ChatTool) => void
  readonly on: (event: "session_start" | "session_shutdown", handler: () => void) => void
  readonly sendMessage: (message: { readonly customType: string; readonly content: string; readonly display: boolean }, options?: { readonly triggerTurn?: boolean }) => void
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

const ClosedTask = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.Literal("closed"),
  outcome: Schema.Literals(["done", "failed", "start-failed"]),
  reason: Schema.String,
  pr: Schema.NullOr(Schema.String)
})
type ClosedTask = typeof ClosedTask.Type

const OpenTask = Schema.Struct({ id: Schema.String, status: Schema.Literals(["new", "taken", "started"]) })

const BacklogTasks = Schema.fromJsonString(Schema.Struct({ tasks: Schema.Array(Schema.Union([ClosedTask, OpenTask])) }))

const closedPollMillis = 15_000

const addedTask = /^added (\S+) for /

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

const closedLine = (task: ClosedTask): string =>
  task.id + " " + task.title + " closed " + task.outcome + (task.reason === "" ? "" : ": " + task.reason) +
  (task.pr === null ? ", with no PR" : ", PR " + task.pr)

const followAdded = (followed: Set<string>, line: string): string => {
  const id = addedTask.exec(line)?.[1]
  if (id === undefined) {
    return line + "\norc chat cannot follow this task to its close, as orc named no task id"
  }
  followed.add(id)
  return line
}

export const chatSession = (env: Env, post: (text: string) => void): ChatSession => {
  const followed = new Set<string>()
  let unreadBecause: string | null = null
  const tools: ReadonlyArray<ChatTool> = [
    {
      name: "orc_backlog_add",
      label: "Add to the orc backlog",
      description:
        "Adds one task to the orc backlog through orc backlog add, and returns the line orc prints, which names the new task's id. When the task closes, orc chat posts its outcome and PR here.",
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
            Effect.map((line) => textResult(followAdded(followed, line)))
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
  const postClosed = Effect.gen(function*() {
    if (followed.size === 0) {
      return
    }
    const backlog = yield* runOrc(env, ["backlog", "--json"], null).pipe(
      Effect.flatMap((text) =>
        Schema.decodeEffect(BacklogTasks)(text).pipe(
          Effect.mapError((error) => new ChatToolError({ message: "orc backlog --json printed no backlog orc chat reads: " + error.message }))
        )
      )
    )
    unreadBecause = null
    for (const task of backlog.tasks) {
      // Two polls can overlap, so only the one that still follows the task posts it.
      if (task.status === "closed" && followed.delete(task.id)) {
        post(closedLine(task))
      }
    }
  }).pipe(
    Effect.catchTag("ChatToolError", (error) =>
      Effect.sync(() => {
        if (error.message !== unreadBecause) {
          unreadBecause = error.message
          post("orc chat cannot read the backlog to follow " + [...followed].join(", ") + ": " + error.message)
        }
      })
    )
  )
  return { tools, postClosed: () => Effect.runPromise(postClosed) }
}

export const chatToolNames: ReadonlyArray<string> = chatSession({}, () => undefined).tools.map((tool) => tool.name)

export const chatExtension = (env: Env, pollMillis: number) => (pi: ChatHost): void => {
  let stopped = false
  const session = chatSession(env, (text) => {
    if (!stopped) {
      pi.sendMessage({ customType: "orc-task-closed", content: text, display: true }, { triggerTurn: false })
    }
  })
  for (const tool of session.tools) {
    pi.registerTool(tool)
  }
  let poll: ReturnType<typeof setInterval> | undefined
  pi.on("session_start", () => {
    stopped = false
    // An unreferenced timer never keeps Pi running after its session ends.
    poll ??= setInterval(() => {
      session.postClosed().catch(() => undefined)
    }, pollMillis).unref()
  })
  pi.on("session_shutdown", () => {
    stopped = true
    clearInterval(poll)
    poll = undefined
  })
}

export default chatExtension(process.env, closedPollMillis)
