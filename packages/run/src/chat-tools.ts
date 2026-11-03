import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { Data, Effect, Layer, Schema } from "effect"
import { ParkedJson, parkedListing } from "./chat-parked"
import { capture } from "./dispatch/runner"
import { ClosedTask, closedLine } from "./chat-closed"
import { AddTaskInput, AnswerInput, HoldInput, MergeInput } from "./chat-inputs"

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
  readonly postHeld: () => Promise<boolean>
  readonly postParked: () => Promise<void>
  readonly listParkedAgain: () => void
}

type PostKind = "closed" | "event" | "held" | "parked"

const postTypes = { closed: "orc-task-closed", event: "orc-event", held: "orc-held-decision", parked: "orc-parked-question" } as const satisfies Record<PostKind, string>

interface SessionStartContext {
  readonly isIdle: () => boolean
}

interface ChatHost {
  readonly registerTool: (tool: ChatTool) => void
  readonly on: (event: "session_start" | "session_shutdown", handler: (event: string, ctx?: SessionStartContext) => void) => void
  readonly sendMessage: (message: { readonly customType: string; readonly content: string; readonly display: boolean }, options?: { readonly triggerTurn?: boolean }) => void
}

type Env = Readonly<Record<string, string | undefined>>

// Pi runs this file under Node, and these Bun layers are the shared Node implementations.
const spawnerLayer = BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)))

const definedEnv = (env: Env): Record<string, string> =>
  Object.fromEntries(Object.entries(env).flatMap(([name, value]) => value === undefined ? [] : [[name, value]]))

const OrcCommand = Schema.fromJsonString(Schema.NonEmptyArray(Schema.String))

// Effect writes an empty struct as {"not":{"type":"null"}}, and Pi takes only an object schema.
const noParameters = { type: "object", properties: {}, additionalProperties: false } as const

const HoldJson = Schema.Struct({
  reason: Schema.String,
  until: Schema.NullOr(Schema.String),
  answer: Schema.NullOr(Schema.Struct({ words: Schema.String, at: Schema.String }))
})

const OpenTask = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.Literals(["new", "taken", "started"]),
  hold: Schema.NullOr(HoldJson),
  parked: Schema.NullOr(ParkedJson)
})
type OpenTask = typeof OpenTask.Type
type BacklogTask = ClosedTask | OpenTask

const BacklogEvent = Schema.Struct({ key: Schema.String, text: Schema.String })

const BacklogTasks = Schema.fromJsonString(Schema.Struct({ tasks: Schema.Array(Schema.Union([ClosedTask, OpenTask])), events: Schema.Array(BacklogEvent) }))

const closedPollMillis = 15_000

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

interface PostState {
  unreadBecause: string | null
  unreadHeldBecause: string | null
  readonly delivered: Set<string>
}

type Deliver = (text: string) => boolean

const readBacklog = (env: Env): Effect.Effect<typeof BacklogTasks.Type, ChatToolError> =>
  runOrc(env, ["backlog", "--json"], null).pipe(
    Effect.flatMap((text) =>
      Schema.decodeEffect(BacklogTasks)(text).pipe(
        Effect.mapError((error) => new ChatToolError({ message: "orc backlog --json printed no backlog orc chat reads: " + error.message }))
      )
    )
  )

const isUnpostedClosed = (task: BacklogTask, isOpen: () => boolean): task is ClosedTask =>
  task.status === "closed" && task.postedAt === null && isOpen()

interface Post {
  readonly key: string
  readonly text: string
  readonly deliver: Deliver
}

const deliverOnce = (state: PostState, post: Post): void => {
  if (!state.delivered.has(post.key)) {
    post.deliver(post.text)
    state.delivered.add(post.key)
  }
}

const markOne = (env: Env, key: string): Effect.Effect<true | string> =>
  runOrc(env, ["backlog", "posted", key], null).pipe(
    Effect.as<true>(true),
    Effect.catchTag("ChatToolError", (error) => Effect.succeed(error.message))
  )

const postOne = (env: Env, state: PostState, post: Post): Effect.Effect<string | null> =>
  Effect.gen(function*() {
    deliverOnce(state, post)
    const marked = yield* markOne(env, post.key)
    if (typeof marked === "string") {
      return marked
    }
    state.delivered.delete(post.key)
    return null
  })

const reportMarks = (state: PostState, deliver: Deliver, markProblem: string | null): Effect.Effect<void> =>
  Effect.sync(() => {
    if (markProblem === null) {
      state.unreadBecause = null
      return
    }
    if (state.unreadBecause !== null) {
      state.unreadBecause = markProblem
      return
    }
    if (deliver("orc chat cannot post the closed tasks and events: " + markProblem)) {
      state.unreadBecause = markProblem
    }
  })

const reportReadError = (state: PostState, deliver: Deliver, error: ChatToolError): Effect.Effect<void> =>
  Effect.sync(() => {
    if (error.message !== state.unreadBecause) {
      if (deliver("orc chat cannot post the closed tasks and events: " + error.message)) {
        state.unreadBecause = error.message
      }
    }
  })

const postUnposted = (env: Env, isOpen: () => boolean, deliverAs: (kind: PostKind) => Deliver, state: PostState): Effect.Effect<void> =>
  Effect.gen(function*() {
    const backlog = yield* readBacklog(env)
    const deliver = deliverAs("closed")
    const posts: ReadonlyArray<Post> = [
      ...backlog.tasks.filter((task) => isUnpostedClosed(task, isOpen)).map((task) => ({ key: task.id, text: closedLine(task), deliver })),
      ...backlog.events.map((event) => ({ key: event.key, text: event.text, deliver: deliverAs("event") }))
    ]
    let markProblem: string | null = null
    for (const post of posts) {
      if (!isOpen()) {
        break
      }
      const problem = yield* postOne(env, state, post)
      markProblem ??= problem
    }
    yield* reportMarks(state, deliver, markProblem)
  }).pipe(Effect.catchTag("ChatToolError", (error) => reportReadError(state, deliverAs("closed"), error)))

type OpenHeld = OpenTask & { readonly hold: typeof HoldJson.Type & { readonly answer: null } }

const isOpenHeld = (task: BacklogTask): task is OpenHeld => task.status !== "closed" && task.hold !== null && task.hold.answer === null

const heldLine = (task: OpenHeld): string =>
  task.id + " " + task.title + " is held for the captain: " + task.hold.reason + (task.hold.until === null ? "" : ", until " + task.hold.until)

// Delivered is false only when Pi took none of the lines, so the caller tries the whole list again.
const postOpenHeld = (env: Env, deliver: Deliver, state: PostState): Effect.Effect<boolean> =>
  readBacklog(env).pipe(
    Effect.map((backlog) => backlog.tasks.filter(isOpenHeld).map(heldLine)),
    Effect.map((lines) => {
      state.unreadHeldBecause = null
      if (lines.length === 0) {
        return true
      }
      const [first, ...rest] = lines
      if (!deliver(first)) {
        return false
      }
      for (const line of rest) {
        deliver(line)
      }
      return true
    }),
    Effect.catchTag("ChatToolError", (error) =>
      Effect.sync(() => {
        if (error.message !== state.unreadHeldBecause) {
          if (deliver("orc chat cannot list the held decisions: " + error.message)) {
            state.unreadHeldBecause = error.message
          }
        }
        return false
      })
    )
  )

const runTool = <A>(schema: Schema.Decoder<A>, name: string, params: unknown, env: Env, args: (input: A) => ReadonlyArray<string>): Promise<TextResult> =>
  Effect.runPromise(
    decodeInput(schema, name, params).pipe(
      Effect.flatMap((input) => runOrc(env, args(input), null)),
      Effect.map(textResult)
    )
  )

export const chatSession = (env: Env, isOpen: () => boolean, post: (text: string, kind: PostKind) => void): ChatSession => {
  const state: PostState = { unreadBecause: null, unreadHeldBecause: null, delivered: new Set<string>() }
  const deliverAs = (kind: PostKind) => (text: string): boolean => {
    if (isOpen()) {
      post(text, kind)
      return true
    }
    return false
  }
  const tools: ReadonlyArray<ChatTool> = [
    {
      name: "orc_backlog_add",
      label: "Add to the orc backlog",
      description:
        "Adds one task to the orc backlog through orc backlog add, and returns the line orc prints, which names the new task's id. When the task closes, orc chat posts its outcome and its PR, or its report for a scout or task, and later posts when its PR turns green and when it merges.",
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
                ...(input.kind === undefined ? [] : ["--kind", input.kind]),
                ...(input.internal === true ? ["--internal"] : []),
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
      description: "Returns orc backlog --json: every new, taken and closed task with its project, kind, machine, outcome, PR and report, the project list, and the room on each machine.",
      parameters: noParameters,
      execute: () => Effect.runPromise(runOrc(env, ["backlog", "--json"], null).pipe(Effect.map(textResult)))
    },
    {
      name: "orc_backlog_hold",
      label: "Hold an orc task for the captain",
      description:
        "Holds one new task through orc backlog hold, so no beat starts it until the captain answers. A passed until date does not release it; only orc_backlog_answer does. Holding a held task again keeps the first reason.",
      parameters: Schema.toJsonSchemaDocument(HoldInput).schema,
      execute: (_toolCallId, params) =>
        runTool(HoldInput, "orc_backlog_hold", params, env, (input) => [
          "backlog",
          "hold",
          input.id,
          "--reason",
          input.reason,
          ...(input.until === undefined ? [] : ["--until", input.until])
        ])
    },
    {
      name: "orc_backlog_answer",
      label: "Answer a held or parked orc task",
      description:
        "Records the captain's words through orc backlog answer, word for word. On a held task it releases the task for the next beat. On a parked task it answers the one question named, and the beat resumes the run on its branch once every question is answered.",
      parameters: Schema.toJsonSchemaDocument(AnswerInput).schema,
      execute: (_toolCallId, params) =>
        runTool(AnswerInput, "orc_backlog_answer", params, env, (input) =>
          ["backlog", "answer", input.id, input.question === undefined ? input.words : input.question + "=" + input.words])
    },
    {
      name: "merge_task",
      label: "Merge an orc task's PR",
      description:
        "Squash-merges a closed task's PR through orc merge, which merges nothing and says why when the PR is not open, a check is red or has not reported, or the branch is behind its base. Call it only when asked to merge that PR, with basis captain-word on the captain's explicit word, or with basis yolo-green when asked about a yolo project's PR and the PR is green. orc refuses yolo-green for a project without yolo true.",
      parameters: Schema.toJsonSchemaDocument(MergeInput).schema,
      execute: (_toolCallId, params) =>
        runTool(MergeInput, "merge_task", params, env, (input) => ["merge", input.id, "--basis", input.basis])
    }
  ]
  const postClosed = postUnposted(env, isOpen, deliverAs, state)
  const postHeld = postOpenHeld(env, deliverAs("held"), state)
  const parked = parkedListing(readBacklog(env).pipe(Effect.map((backlog) => backlog.tasks)), deliverAs("parked"))
  const postParked = () => Effect.runPromise(parked.post)
  return { tools, postClosed: () => Effect.runPromise(postClosed), postHeld: () => Effect.runPromise(postHeld), postParked, listParkedAgain: parked.forget }
}

export const chatToolNames: ReadonlyArray<string> = chatSession({}, () => false, () => undefined).tools.map((tool) => tool.name)

export const chatExtension = (env: Env, pollMillis: number) => (pi: ChatHost): void => {
  let stopped = true
  let idle: (() => boolean) | null = null
  const session = chatSession(env, () => !stopped && (idle?.() ?? false), (text, kind) => {
    pi.sendMessage({ customType: postTypes[kind], content: text, display: true }, { triggerTurn: false })
  })
  for (const tool of session.tools) {
    pi.registerTool(tool)
  }
  let poll: ReturnType<typeof setInterval> | undefined
  let current: Promise<void> | null = null
  let heldDue = false
  const postHeldIfDue = (): Promise<void> =>
    heldDue
      ? session.postHeld().then((delivered) => {
        heldDue = heldDue && !delivered
      })
      : Promise.resolve()
  pi.on("session_start", (_event, ctx) => {
    stopped = false
    idle = ctx?.isIdle ?? null
    heldDue = true
    session.listParkedAgain()
    const postClosed = () => {
      if (current !== null) {
        return
      }
      const run = postHeldIfDue().then(() => session.postParked()).then(() => session.postClosed())
      current = run
      run.then(() => {
        if (current === run) {
          current = null
        }
      }, () => {
        if (current === run) {
          current = null
        }
      })
    }
    postClosed()
    // An unreferenced timer never keeps Pi running after its session ends.
    poll ??= setInterval(postClosed, pollMillis).unref()
  })
  pi.on("session_shutdown", () => {
    stopped = true
    idle = null
    clearInterval(poll)
    poll = undefined
    const running = current
    if (running !== null) {
      void running.catch(() => undefined)
    }
  })
}

export default chatExtension(process.env, closedPollMillis)
