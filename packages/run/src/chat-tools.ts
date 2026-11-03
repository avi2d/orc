import { Effect, Schema } from "effect"
import { isOpenHeld, type OpenHeld } from "./chat-backlog"
import { type BoardHost, type Boards, boardsVar, decisionBoards } from "./chat-board"
import { type Env, runCommand } from "./chat-command"
import { ChatToolError } from "./chat-error"
import { type Deliver, postUnposted, type PostState, readBacklog } from "./chat-posts"
import { AddTaskInput, AnswerInput, BoardInput, HoldInput, MergeInput } from "./chat-inputs"
import { lavishLauncher } from "./chat-lavish"
import { parkedListing } from "./chat-parked"

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

export interface ChatSession {
  readonly tools: ReadonlyArray<ChatTool>
  readonly postClosed: () => Promise<void>
  readonly postHeld: () => Promise<boolean>
  readonly postParked: () => Promise<void>
  readonly listParkedAgain: () => void
  readonly listBoards: () => Promise<void>
  readonly reconcileBoards: () => Promise<void>
  readonly postBoardNews: () => void
  readonly stopBoards: () => Promise<void>
}

type PostKind = "closed" | "event" | "held" | "parked" | "board"

const postTypes = {
  closed: "orc-task-closed",
  event: "orc-event",
  held: "orc-held-decision",
  parked: "orc-parked-question",
  board: "orc-decision-board"
} as const satisfies Record<PostKind, string>

export type BoardSetup = Pick<BoardHost, "launcher" | "now">

interface SessionStartContext {
  readonly isIdle: () => boolean
}

interface ChatHost {
  readonly registerTool: (tool: ChatTool) => void
  readonly on: (event: "session_start" | "session_shutdown", handler: (event: string, ctx?: SessionStartContext) => void) => void
  readonly sendMessage: (message: { readonly customType: string; readonly content: string; readonly display: boolean }, options?: { readonly triggerTurn?: boolean }) => void
}

const OrcCommand = Schema.fromJsonString(Schema.NonEmptyArray(Schema.String))

// Effect writes an empty struct as {"not":{"type":"null"}}, and Pi takes only an object schema.
const noParameters = { type: "object", properties: {}, additionalProperties: false } as const

const closedPollMillis = 15_000

const runOrc = (env: Env, args: ReadonlyArray<string>, stdin: string | null): Effect.Effect<string, ChatToolError> =>
  Effect.gen(function*() {
    const command = yield* Schema.decodeEffect(OrcCommand)(env[orcCommandVar] ?? "").pipe(
      Effect.mapError(() => new ChatToolError({ message: "the orc chat tools run only inside orc chat, which names its orc in " + orcCommandVar }))
    )
    return yield* runCommand([...command, ...args], stdin, env)
  })

const textResult = (text: string): TextResult => ({ content: [{ type: "text", text }], details: undefined })

const decodeInput = <A>(schema: Schema.Decoder<A>, tool: string, params: unknown): Effect.Effect<A, ChatToolError> =>
  Schema.decodeUnknownEffect(schema)(params, { onExcessProperty: "error" }).pipe(
    Effect.mapError((error) => new ChatToolError({ message: tool + " takes " + error.message }))
  )

const heldLine = (task: OpenHeld): string =>
  task.id + " " + task.title + " is held for the captain: " + task.hold.reason + (task.hold.until === null ? "" : ", until " + task.hold.until)

// Delivered is false only when Pi took none of the lines, so the caller tries the whole list again.
const postOpenHeld = (env: Env, deliver: Deliver, state: PostState): Effect.Effect<boolean> =>
  readBacklog((args, stdin) => runOrc(env, args, stdin)).pipe(
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

const chatTools = (env: Env, boards: Boards): ReadonlyArray<ChatTool> => [
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
      "Holds one new task through orc backlog hold, so no beat starts it until the captain answers. A passed until date does not release it; only orc_backlog_answer does. Holding a held task again keeps the first reason. A hold with questions waits for an answer to each one, and orc_decision_board puts them on cards for the captain.",
    parameters: Schema.toJsonSchemaDocument(HoldInput).schema,
    execute: (_toolCallId, params) =>
      runTool(HoldInput, "orc_backlog_hold", params, env, (input) => [
        "backlog",
        "hold",
        input.id,
        "--reason",
        input.reason,
        ...(input.until === undefined ? [] : ["--until", input.until]),
        ...(input.questions ?? []).flatMap((question) => ["--question", question])
      ])
  },
  {
    name: "orc_backlog_answer",
    label: "Answer a held or parked orc task",
    description:
      "Records the captain's words through orc backlog answer, word for word. On a held task it releases the task for the next beat, or on a hold with questions answers the one named and releases the task once every question is answered. On a parked task it answers the one question named, and the beat resumes the run on its branch once every question is answered.",
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
  },
  {
    name: "orc_decision_board",
    label: "Open a decision board for a held or parked orc task",
    description:
      "Builds a Lavish decision board for one held or parked task, with one card per open question on its hold or park, each with options and the option you recommend, and returns its link for the captain; it opens no browser. Anyone on the same network who holds the link can open it and submit answers, which orc records as the captain's through orc backlog answer, word for word, because the page has no login. orc posts what it recorded here, and releases the task only once every card is answered. The board is never published through lavish-axi share, a third-party host, or a public tunnel.",
    parameters: Schema.toJsonSchemaDocument(BoardInput).schema,
    execute: (_toolCallId, params) =>
      Effect.runPromise(decodeInput(BoardInput, "orc_decision_board", params).pipe(Effect.flatMap(boards.open), Effect.map(textResult)))
  }
]

export const chatSession = (
  env: Env,
  isOpen: () => boolean,
  post: (text: string, kind: PostKind) => void,
  boardSetup: BoardSetup = { launcher: lavishLauncher(env), now: () => new Date() }
): ChatSession => {
  const state: PostState = { unreadBecause: null, unreadHeldBecause: null, delivered: new Set<string>() }
  const deliverAs = (kind: PostKind) => (text: string): boolean => {
    if (isOpen()) {
      post(text, kind)
      return true
    }
    return false
  }
  const boardNews: Array<string> = []
  const postBoardNews = (): void => {
    while (boardNews.length > 0 && deliverAs("board")(boardNews[0])) {
      boardNews.shift()
    }
  }
  const boards = decisionBoards({
    ...boardSetup,
    dir: env[boardsVar] ?? null,
    orc: (args) => runOrc(env, args, null),
    tasks: readBacklog((args, stdin) => runOrc(env, args, stdin)).pipe(Effect.map((backlog) => backlog.tasks)),
    say: (line) => {
      boardNews.push(line)
      postBoardNews()
    }
  })
  const tools = chatTools(env, boards)
  const postClosed = postUnposted((args, stdin) => runOrc(env, args, stdin), isOpen, deliverAs, state)
  const postHeld = postOpenHeld(env, deliverAs("held"), state)
  const parked = parkedListing(readBacklog((args, stdin) => runOrc(env, args, stdin)).pipe(Effect.map((backlog) => backlog.tasks)), deliverAs("parked"))
  const postParked = () => Effect.runPromise(parked.post)
  return {
    tools,
    postClosed: () => Effect.runPromise(postClosed),
    postHeld: () => Effect.runPromise(postHeld),
    postParked,
    listParkedAgain: parked.forget,
    listBoards: () => Effect.runPromise(boards.listOpen),
    reconcileBoards: () => Effect.runPromise(boards.reconcileWatched),
    postBoardNews,
    stopBoards: () => Effect.runPromise(boards.stop)
  }
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
  let boardsDue = false
  const postHeldIfDue = (): Promise<void> =>
    heldDue
      ? session.postHeld().then((delivered) => {
        heldDue = heldDue && !delivered
      })
      : Promise.resolve()
  const listBoardsIfDue = (): Promise<void> => {
    if (!boardsDue) {
      return Promise.resolve()
    }
    boardsDue = false
    return session.listBoards()
  }
  pi.on("session_start", (_event, ctx) => {
    stopped = false
    idle = ctx?.isIdle ?? null
    heldDue = true
    boardsDue = true
    session.listParkedAgain()
    const postClosed = () => {
      if (current !== null) {
        return
      }
      session.postBoardNews()
      const run = postHeldIfDue().then(listBoardsIfDue).then(() => session.reconcileBoards()).then(() => session.postParked()).then(() => session.postClosed())
      current = run
      const clear = () => {
        if (current === run) {
          current = null
        }
      }
      run.then(clear, clear)
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
    void session.stopBoards()
    const running = current
    if (running !== null) {
      void running.catch(() => undefined)
    }
  })
}

export default chatExtension(process.env, closedPollMillis)
