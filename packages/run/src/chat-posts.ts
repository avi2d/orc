import { Effect, Schema } from "effect"
import { BacklogTasks, type BacklogTask } from "./chat-backlog"
import { type ClosedTask, closedLine } from "./chat-closed"
import { ChatToolError } from "./chat-error"

export interface PostState {
  unreadBecause: string | null
  unreadHeldBecause: string | null
  readonly delivered: Set<string>
}

export type Deliver = (text: string) => boolean

type RunOrc = (args: ReadonlyArray<string>, stdin: string | null) => Effect.Effect<string, ChatToolError>

export const readBacklog = (runOrc: RunOrc): Effect.Effect<typeof BacklogTasks.Type, ChatToolError> =>
  runOrc(["backlog", "--json"], null).pipe(
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

const markOne = (runOrc: RunOrc, key: string): Effect.Effect<true | string> =>
  runOrc(["backlog", "posted", key], null).pipe(
    Effect.as<true>(true),
    Effect.catchTag("ChatToolError", (error) => Effect.succeed(error.message))
  )

const postOne = (runOrc: RunOrc, state: PostState, post: Post): Effect.Effect<string | null> =>
  Effect.gen(function*() {
    deliverOnce(state, post)
    const marked = yield* markOne(runOrc, post.key)
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

export const postUnposted = (runOrc: RunOrc, isOpen: () => boolean, deliverAs: (kind: "closed" | "event") => Deliver, state: PostState): Effect.Effect<void> =>
  Effect.gen(function*() {
    const backlog = yield* readBacklog(runOrc)
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
      const problem = yield* postOne(runOrc, state, post)
      markProblem ??= problem
    }
    yield* reportMarks(state, deliver, markProblem)
  }).pipe(Effect.catchTag("ChatToolError", (error) => reportReadError(state, deliverAs("closed"), error)))
