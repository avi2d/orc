import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { type ChatSession, chatSession } from "../../packages/run/src/features/chat/chat-tools"
import type { BoardLauncher, BoardPoll } from "../../packages/run/src/features/chat/chat-lavish"
import { chatEnv, type Fixture } from "./chat-helpers"

const SavedBoard = Schema.fromJsonString(Schema.Struct({ board: Schema.String }))

export const savedBoardId = (boardsDir: string): string =>
  Schema.decodeSync(SavedBoard)(readFileSync(join(boardsDir, "orc-1", "board.json"), "utf8")).board

const HeldJson = Schema.fromJsonString(Schema.Struct({
  tasks: Schema.Array(Schema.Struct({
    id: Schema.String,
    status: Schema.String,
    hold: Schema.NullOr(Schema.Struct({
      questions: Schema.Array(Schema.Struct({ id: Schema.String, answer: Schema.NullOr(Schema.Struct({ words: Schema.String })) })),
      answer: Schema.NullOr(Schema.Struct({ words: Schema.String }))
    })),
    parked: Schema.NullOr(Schema.Struct({
      branch: Schema.String,
      questions: Schema.Array(Schema.Struct({ id: Schema.String, answer: Schema.NullOr(Schema.Struct({ words: Schema.String })) }))
    }))
  }))
}))

export const openedAt = new Date("2026-11-03T09:30:00.000Z")

interface FakeLavish {
  readonly launcher: BoardLauncher
  readonly opened: Array<string>
  readonly ended: Array<string>
  readonly replies: Array<string>
  readonly send: (poll: BoardPoll) => void
  readonly answer: (card: string, option: string, words?: string) => void
  readonly polls: () => number
}

export const fakeLavish = (boardsDir: string): FakeLavish => {
  const waiting: Array<(poll: BoardPoll) => void> = []
  const queued: Array<BoardPoll> = []
  const opened: Array<string> = []
  const ended: Array<string> = []
  const replies: Array<string> = []
  let polls = 0
  const launcher: BoardLauncher = {
    open: (file) => Effect.sync(() => {
      opened.push(file)
      return { url: "http://127.0.0.1:4387/session/board-" + opened.length, networkWarning: "" }
    }),
    poll: () => Effect.promise(() => new Promise<BoardPoll>((resolve) => {
      polls += 1
      const next = queued.shift()
      if (next === undefined) {
        waiting.push(resolve)
      } else {
        resolve(next)
      }
    })),
    reply: (_file, text) => Effect.sync(() => {
      replies.push("reply: " + text)
    }),
    end: (file) => Effect.sync(() => {
      replies.push("end")
      ended.push(file)
    })
  }
  const send = (poll: BoardPoll): void => {
    const resolve = waiting.shift()
    if (resolve === undefined) {
      queued.push(poll)
    } else {
      resolve(poll)
    }
  }
  const answer = (card: string, option: string, words?: string): void => {
    const board = savedBoardId(boardsDir)
    send({ kind: "feedback", prompts: [{ tag: "orc-board-answer", text: card + ": " + option, data: words === undefined ? { board, card, answer: option } : { board, card, answer: option, words } }] })
  }
  return { launcher, opened, ended, replies, send, answer, polls: () => polls }
}

interface BoardChat {
  readonly session: ChatSession
  readonly call: (name: string, params: unknown) => Promise<string>
  readonly held: () => Promise<typeof HeldJson.Type["tasks"][number] | undefined>
  readonly boardLines: () => Array<string>
}

export const boardChat = (fixture: Fixture, lavish: FakeLavish): BoardChat => {
  const posted: Array<{ readonly text: string; readonly kind: string }> = []
  const env = { ...chatEnv(fixture), ORC_CHAT_BOARDS: join(fixture.home, "boards") }
  const session = chatSession(env, () => true, (text, kind) => posted.push({ text, kind }), { launcher: lavish.launcher, now: () => openedAt })
  const byName = new Map(session.tools.map((tool) => [tool.name, tool]))
  const call = (name: string, params: unknown): Promise<string> =>
    byName.get(name)?.execute("call-1", params).then((result) => result.content.map((block) => block.text).join("")) ?? Promise.reject(new Error("no tool " + name))
  const held = async () => {
    const backlog = Schema.decodeSync(HeldJson)(await call("orc_backlog", {}))
    return backlog.tasks.find((task) => task.id === "orc-1")
  }
  const boardLines = () => posted.filter((entry) => entry.kind === "board").map((entry) => entry.text)
  return { session, call, held, boardLines }
}

export const until = async (done: () => boolean): Promise<void> => {
  const end = Date.now() + 20_000
  while (!done() && Date.now() < end) {
    await Bun.sleep(20)
  }
}

export const holdTwo = async (call: (name: string, params: unknown) => Promise<string>): Promise<void> => {
  await call("orc_backlog_add", { project: "orc", task: "# Pick the API\n" })
  await call("orc_backlog_hold", { id: "orc-1", reason: "two choices before the run", questions: ["REST or gRPC?", "Which region?"] })
}

export const twoCards = {
  id: "orc-1",
  cards: [
    { question: "question-1", options: ["REST", "gRPC"], recommended: "gRPC" },
    { question: "question-2", options: ["eu-west", "us-east"], recommended: "eu-west" }
  ]
}
