import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { chatSession } from "../../packages/run/src/chat-tools"
import type { BoardLauncher, BoardPoll } from "../../packages/run/src/chat-lavish"
import { chatEnv, type Fixture, withFixture } from "./chat-helpers"

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

const openedAt = new Date("2026-11-03T09:30:00.000Z")

const fakeLavish = () => {
  const waiting: Array<(poll: BoardPoll) => void> = []
  const queued: Array<BoardPoll> = []
  const opened: Array<string> = []
  const ended: Array<string> = []
  const replies: Array<string> = []
  let polls = 0
  const launcher: BoardLauncher = {
    open: (file) => Effect.sync(() => {
      opened.push(file)
      return "http://127.0.0.1:4387/session/board-" + opened.length
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
  const answer = (card: string, option: string, words?: string): void =>
    send({ kind: "feedback", prompts: [{ tag: "orc-board-answer", text: card + ": " + option, data: words === undefined ? { card, answer: option } : { card, answer: option, words } }] })
  return { launcher, opened, ended, replies, send, answer, polls: () => polls }
}

const boardChat = (fixture: Fixture, lavish: ReturnType<typeof fakeLavish>) => {
  const posted: Array<{ readonly text: string; readonly kind: string }> = []
  const env = { ...chatEnv(fixture), ORC_CHAT_BOARDS: join(fixture.home, "boards") }
  const session = chatSession(env, () => true, (text, kind) => posted.push({ text, kind }), { launcher: lavish.launcher, now: () => openedAt })
  const byName = new Map(session.tools.map((tool) => [tool.name, tool]))
  const call = (name: string, params: unknown): Promise<string> =>
    byName.get(name)?.execute("call-1", params).then((result) => result.content.map((block) => block.text).join("")) ?? Promise.reject(new Error("no tool " + name))
  const held = async () => {
    const backlog = Schema.decodeSync(HeldJson)(await call("orc_backlog", {}))
    return backlog.tasks.find((task) => task.id === "task-1")
  }
  const boardLines = () => posted.filter((entry) => entry.kind === "board").map((entry) => entry.text)
  return { session, call, held, boardLines }
}

const until = async (done: () => boolean): Promise<void> => {
  const end = Date.now() + 20_000
  while (!done() && Date.now() < end) {
    await Bun.sleep(20)
  }
}

const refusal = (error: unknown): string => error instanceof Error ? error.message : String(error)

const holdTwo = async (call: (name: string, params: unknown) => Promise<string>): Promise<void> => {
  await call("orc_backlog_add", { project: "orc", task: "# Pick the API\n" })
  await call("orc_backlog_hold", { id: "task-1", reason: "two choices before the run", questions: ["REST or gRPC?", "Which region?"] })
}

const parkTwo = async (fixture: Fixture, call: (name: string, params: unknown) => Promise<string>): Promise<void> => {
  await call("orc_backlog_add", { project: "orc", task: "# Pick the API\n" })
  const file = join(fixture.home, "backlog", "new", "task-1.md")
  const text = await readFile(file, "utf8")
  const end = text.indexOf("\n---\n", 4)
  const questions = [{ id: "question-4", text: "Keep the retries?" }, { id: "question-5", text: "Which timeout?" }]
  await writeFile(file + ".tmp", text.slice(0, end) + "\nparked_branch: \"orc/task-1\"\nparked_questions: " + JSON.stringify(questions) + text.slice(end))
  await rename(file + ".tmp", file)
}

const twoCards = {
  id: "task-1",
  cards: [
    { question: "question-1", options: ["REST", "gRPC"], recommended: "gRPC" },
    { question: "question-2", options: ["eu-west", "us-east"], recommended: "eu-west" }
  ]
}

describe("orc chat decision boards", () => {
  test("each card's answer is recorded word for word and the task stays held until the last card instead of releasing on the first", async () => {
    await withFixture(null, 0, async (fixture) => {
      const lavish = fakeLavish()
      const chat = boardChat(fixture, lavish)
      await holdTwo(chat.call)
      const board = join(fixture.home, "boards", "task-1", "board.html")
      expect(await chat.call("orc_decision_board", twoCards)).toBe(
        "opened task-1's decision board with 2 cards at http://127.0.0.1:4387/session/board-1. orc records each answer the captain sends from it, word for word, and keeps the task held until every card is answered."
      )
      expect(lavish.opened).toEqual([board])
      lavish.answer("question-1", "gRPC")
      await until(() => chat.boardLines().length === 1)
      expect(chat.boardLines()).toEqual(["From task-1's decision board, REST or gRPC? gRPC: answered question-1 on task-1, and it stays held for question-2"])
      expect(await chat.held()).toEqual({
        id: "task-1",
        status: "new",
        hold: { questions: [{ id: "question-1", answer: { words: "gRPC" } }, { id: "question-2", answer: null }], answer: null },
        parked: null
      })
      await until(() => readFileSync(board, "utf8").includes("1 of 2 cards wait"))
      expect(lavish.ended).toEqual([])
      lavish.answer("question-2", "us-east")
      await until(() => chat.boardLines().length === 3)
      expect(chat.boardLines().slice(1)).toEqual([
        "From task-1's decision board, Which region? us-east: answered question-2 on task-1, so the beat may start it",
        "task-1 is no longer held, so orc closed its decision board"
      ])
      expect(lavish.ended).toEqual([board])
      expect(lavish.replies).toEqual([
        "reply: answered question-1 on task-1, and it stays held for question-2",
        "reply: answered question-2 on task-1, so the beat may start it",
        "end"
      ])
      expect((await chat.held())?.hold?.answer).toEqual({ words: "REST or gRPC?: gRPC\nWhich region?: us-east" })
      await until(() => readFileSync(join(fixture.home, "boards", "task-1", "board.html"), "utf8").includes("Every card is answered."))
      const doneHtml = await readFile(join(fixture.home, "boards", "task-1", "board.html"), "utf8")
      expect(doneHtml).toContain("Recorded: <strong>gRPC</strong>")
      expect(doneHtml).toContain("Recorded: <strong>us-east</strong>")
      await chat.session.stopBoards()
    })
  }, 60_000)

  test("a parked run's cards answer its question ids word for word and close only once the last is answered instead of refusing a parked task", async () => {
    await withFixture(null, 0, async (fixture) => {
      const lavish = fakeLavish()
      const chat = boardChat(fixture, lavish)
      await parkTwo(fixture, chat.call)
      const cards = [
        { question: "question-4", options: ["keep three", "drop them"], recommended: "keep three" },
        { question: "question-5", options: ["30s", "2m"], recommended: "30s" }
      ]
      expect(await chat.call("orc_decision_board", { id: "task-1", cards })).toEndWith("keeps the task parked until every card is answered.")
      lavish.answer("question-4", "drop them")
      await until(() => chat.boardLines().length === 1)
      expect(chat.boardLines()).toEqual(["From task-1's decision board, Keep the retries? drop them: answered question-4 on task-1, and it stays parked for question-5"])
      expect((await chat.held())?.parked).toEqual({
        branch: "orc/task-1",
        questions: [{ id: "question-4", answer: { words: "drop them" } }, { id: "question-5", answer: null }]
      })
      expect(lavish.ended).toEqual([])
      lavish.answer("question-5", "2m")
      await until(() => chat.boardLines().length === 3)
      expect(chat.boardLines().slice(1)).toEqual([
        "From task-1's decision board, Which timeout? 2m: answered question-5 on task-1, so the beat resumes it on orc/task-1",
        "task-1 is no longer parked, so orc closed its decision board"
      ])
      expect((await chat.held())?.parked?.questions.map((question) => question.answer)).toEqual([{ words: "drop them" }, { words: "2m" }])
      await chat.session.stopBoards()
    })
  }, 60_000)

  test("a session ended in Lavish stops the reading and leaves the task held instead of polling it again or ending it twice", async () => {
    await withFixture(null, 0, async (fixture) => {
      const lavish = fakeLavish()
      const chat = boardChat(fixture, lavish)
      await holdTwo(chat.call)
      await chat.call("orc_decision_board", twoCards)
      await until(() => lavish.polls() === 1)
      lavish.send({ kind: "closed", status: "ended" })
      await until(() => chat.boardLines().length === 1)
      expect(chat.boardLines()).toEqual(["task-1's decision board's Lavish session is ended, so orc stopped reading it; open it again to answer the rest"])
      await Bun.sleep(100)
      expect(lavish.polls()).toBe(1)
      expect(lavish.ended).toEqual([])
      expect((await chat.held())?.status).toBe("new")
      expect((await chat.held())?.hold?.answer).toBeNull()
      await chat.session.stopBoards()
    })
  }, 60_000)

  test("the page marks the recorded card and keeps the open one answerable instead of showing every card open", async () => {
    await withFixture(null, 0, async (fixture) => {
      const lavish = fakeLavish()
      const chat = boardChat(fixture, lavish)
      await holdTwo(chat.call)
      await chat.call("orc_decision_board", twoCards)
      const page = join(fixture.home, "boards", "task-1", "board.html")
      const first = await readFile(page, "utf8")
      expect(first).toContain("2 of 2 cards wait for your answer")
      expect(first.match(/<section class="card /g)?.length).toBe(2)
      expect(first.match(/<input type="radio"[^>]*value="[^"]*"( checked)?>/g)).toEqual([
        "<input type=\"radio\" class=\"radio radio-primary\" name=\"answer\" value=\"REST\">",
        "<input type=\"radio\" class=\"radio radio-primary\" name=\"answer\" value=\"gRPC\" checked>",
        "<input type=\"radio\" class=\"radio radio-primary\" name=\"answer\" value=\"eu-west\" checked>",
        "<input type=\"radio\" class=\"radio radio-primary\" name=\"answer\" value=\"us-east\">"
      ])
      expect(first.match(/Recommended<\/span>/g)?.length).toBe(2)
      lavish.answer("question-1", "gRPC")
      await until(() => chat.boardLines().length === 1)
      await until(() => readFileSync(page, "utf8").includes("1 of 2 cards wait"))
      const html = await readFile(page, "utf8")
      expect(html).toContain("1 of 2 cards wait for your answer")
      expect(html).toContain("Recorded: <strong>gRPC</strong>")
      expect(html).toContain("<form data-card=\"question-2\"")
      expect(html).not.toContain("<form data-card=\"question-1\"")
      await chat.session.stopBoards()
    })
  }, 60_000)

  test("words the captain adds to an option are recorded after it as written instead of dropped or trimmed", async () => {
    await withFixture(null, 0, async (fixture) => {
      const lavish = fakeLavish()
      const chat = boardChat(fixture, lavish)
      await holdTwo(chat.call)
      await chat.call("orc_decision_board", twoCards)
      lavish.answer("question-1", "gRPC", " we stream logs both ways ")
      await until(() => chat.boardLines().length === 1)
      lavish.answer("question-2", "eu-west", "   ")
      await until(() => chat.boardLines().length === 3)
      expect((await chat.held())?.hold?.questions.map((question) => question.answer)).toEqual([{ words: "gRPC —  we stream logs both ways " }, { words: "eu-west" }])
      await chat.session.stopBoards()
    })
  }, 60_000)

  test("an answer that is none of the card's options records nothing instead of the sent words", async () => {
    await withFixture(null, 0, async (fixture) => {
      const lavish = fakeLavish()
      const chat = boardChat(fixture, lavish)
      await holdTwo(chat.call)
      await chat.call("orc_decision_board", twoCards)
      lavish.answer("question-1", "SOAP")
      await until(() => chat.boardLines().length === 1)
      expect(chat.boardLines()).toEqual(["task-1's decision board sent an answer that matches none of its cards, so orc recorded nothing: question-1: SOAP"])
      expect((await chat.held())?.hold?.questions.map((question) => question.answer)).toEqual([null, null])
      await chat.session.stopBoards()
    })
  }, 60_000)

  test("a board that leaves out an open question is refused instead of opened partly", async () => {
    await withFixture(null, 0, async (fixture) => {
      const lavish = fakeLavish()
      const chat = boardChat(fixture, lavish)
      await holdTwo(chat.call)
      const refused = await chat.call("orc_decision_board", { id: "task-1", cards: [twoCards.cards[0]] }).then(String, refusal)
      expect(refused).toBe("task-1 is held on question-1, question-2, so its board takes one card for each of those, not question-1")
      expect(lavish.opened).toEqual([])
    })
  }, 60_000)

  test("a recommendation outside a card's options is refused instead of shown as recommended", async () => {
    await withFixture(null, 0, async (fixture) => {
      const lavish = fakeLavish()
      const chat = boardChat(fixture, lavish)
      await holdTwo(chat.call)
      const cards = [twoCards.cards[0], { question: "question-2", options: ["eu-west"], recommended: "mars" }]
      const refused = await chat.call("orc_decision_board", { id: "task-1", cards }).then(String, refusal)
      expect(refused).toBe("a card on task-1's board recommends mars, which is not one of its options: eu-west")
    })
  }, 60_000)

  test("a hold with a reason and no questions takes one card whose answer releases it instead of needing a question id", async () => {
    await withFixture(null, 0, async (fixture) => {
      const lavish = fakeLavish()
      const chat = boardChat(fixture, lavish)
      await chat.call("orc_backlog_add", { project: "orc", task: "# Pick the API\n" })
      await chat.call("orc_backlog_hold", { id: "task-1", reason: "REST or gRPC?" })
      await chat.call("orc_decision_board", { id: "task-1", cards: [{ options: ["REST", "gRPC"], recommended: "REST" }] })
      lavish.answer("reason", "gRPC")
      await until(() => chat.boardLines().length === 2)
      expect(chat.boardLines()).toEqual([
        "From task-1's decision board, REST or gRPC? gRPC: answered task-1, so the beat may start it",
        "task-1 is no longer held, so orc closed its decision board"
      ])
      expect((await chat.held())?.hold?.answer).toEqual({ words: "gRPC" })
    })
  }, 60_000)

  test("a board answer for a question answered elsewhere records nothing instead of overwriting it", async () => {
    await withFixture(null, 0, async (fixture) => {
      const lavish = fakeLavish()
      const chat = boardChat(fixture, lavish)
      await holdTwo(chat.call)
      await chat.call("orc_decision_board", twoCards)
      await chat.call("orc_backlog_answer", { id: "task-1", question: "question-1", words: "REST" })
      lavish.answer("question-1", "gRPC")
      await until(() => chat.boardLines().length === 1)
      expect(chat.boardLines()).toEqual(["task-1's decision board no longer describes its current decision, so orc recorded nothing: question-1: gRPC"])
      expect((await chat.held())?.hold?.questions.map((question) => question.answer)).toEqual([{ words: "REST" }, null])
      await until(() => readFileSync(join(fixture.home, "boards", "task-1", "board.html"), "utf8").includes("Recorded: <strong>REST</strong>"))
      await chat.session.stopBoards()
    })
  }, 60_000)

  test("the chat start lists each board whose task is still held, with the time it opened, instead of none or a released one", async () => {
    await withFixture(null, 0, async (fixture) => {
      const first = fakeLavish()
      const before = boardChat(fixture, first)
      await holdTwo(before.call)
      await before.call("orc_decision_board", twoCards)
      first.answer("question-1", "REST")
      await until(() => before.boardLines().length === 1)
      await before.session.stopBoards()
      await mkdir(join(fixture.home, "boards", "task-9"), { recursive: true })
      await writeFile(join(fixture.home, "boards", "task-9", "board.json"), JSON.stringify({
        task: "task-9", title: "Gone", waits: "held", reason: "x", openedAt: openedAt.toISOString(), cards: [{ target: { kind: "reason" }, text: "x", options: ["a"], recommended: "a" }]
      }))
      const second = fakeLavish()
      const after = boardChat(fixture, second)
      await after.session.listBoards()
      expect(after.boardLines()).toEqual([
        "task-1 Pick the API has a decision board open since 2026-11-03T09:30:00.000Z, waiting on question-2"
      ])
      expect(second.opened).toEqual([])
      expect(second.polls()).toBe(0)
      await after.call("orc_decision_board", { id: "task-1", cards: [twoCards.cards[1]] })
      expect(second.opened).toEqual([join(fixture.home, "boards", "task-1", "board.html")])
      second.answer("question-2", "eu-west")
      await until(() => after.boardLines().length === 3)
      expect(after.boardLines()[1]).toBe("From task-1's decision board, Which region? eu-west: answered question-2 on task-1, so the beat may start it")
    })
  }, 60_000)
})
