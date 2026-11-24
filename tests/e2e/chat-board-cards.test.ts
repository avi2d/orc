import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type Fixture, withFixture } from "./chat-helpers"
import { boardChat, fakeLavish, holdTwo, twoCards, until } from "./chat-board-helpers"

const refusal = (error: unknown): string => error instanceof Error ? error.message : String(error)

const parkTwo = async (fixture: Fixture, call: (name: string, params: unknown) => Promise<string>): Promise<void> => {
  await call("orc_backlog_add", { project: "orc", task: "# Pick the API\n" })
  const file = join(fixture.home, "backlog", "new", "orc-1.md")
  const text = await readFile(file, "utf8")
  const end = text.indexOf("\n---\n", 4)
  const questions = [{ id: "question-4", text: "Keep the retries?" }, { id: "question-5", text: "Which timeout?" }]
  await writeFile(file + ".tmp", text.slice(0, end) + "\nparked_branch: \"orc/orc-1\"\nparked_questions: " + JSON.stringify(questions) + text.slice(end))
  await rename(file + ".tmp", file)
}

describe("orc chat decision boards", () => {
  test("each card's answer is recorded word for word and the task stays held until the last card instead of releasing on the first", async () => {
    await withFixture(null, 0, async (fixture) => {
      const lavish = fakeLavish(join(fixture.home, "boards"))
      const chat = boardChat(fixture, lavish)
      await holdTwo(chat.call)
      const board = join(fixture.home, "boards", "orc-1", "board.html")
      expect(await chat.call("orc_decision_board", twoCards)).toBe(
        "opened orc-1's decision board with 2 cards at http://127.0.0.1:4387/session/board-1. orc records each answer the captain sends from it, word for word, and keeps the task held until every card is answered. The board opens only on this machine."
      )
      expect(lavish.opened).toEqual([board])
      lavish.answer("question-1", "gRPC")
      await until(() => chat.boardLines().length === 1)
      expect(chat.boardLines()).toEqual(["From orc-1's decision board, REST or gRPC? gRPC: answered question-1 on orc-1, and it stays held for question-2"])
      expect(await chat.held()).toEqual({
        id: "orc-1",
        status: "new",
        hold: { questions: [{ id: "question-1", answer: { words: "gRPC" } }, { id: "question-2", answer: null }], answer: null },
        parked: null
      })
      await until(() => readFileSync(board, "utf8").includes("1 of 2 cards wait"))
      expect(lavish.ended).toEqual([])
      lavish.answer("question-2", "us-east")
      await until(() => chat.boardLines().length === 3)
      expect(chat.boardLines().slice(1)).toEqual([
        "From orc-1's decision board, Which region? us-east: answered question-2 on orc-1, so the beat may start it",
        "orc-1 is no longer held, so orc closed its decision board"
      ])
      expect(lavish.ended).toEqual([board])
      expect(lavish.replies).toEqual([
        "reply: answered question-1 on orc-1, and it stays held for question-2",
        "reply: answered question-2 on orc-1, so the beat may start it",
        "end"
      ])
      expect((await chat.held())?.hold?.answer).toEqual({ words: "REST or gRPC?: gRPC\nWhich region?: us-east" })
      await until(() => readFileSync(join(fixture.home, "boards", "orc-1", "board.html"), "utf8").includes("Every card is answered."))
      const doneHtml = await readFile(join(fixture.home, "boards", "orc-1", "board.html"), "utf8")
      expect(doneHtml).toContain("Recorded: <strong>gRPC</strong>")
      expect(doneHtml).toContain("Recorded: <strong>us-east</strong>")
      await chat.session.stopBoards()
    })
  }, 60_000)

  test("a parked run's cards answer its question ids word for word and close only once the last is answered instead of refusing a parked task", async () => {
    await withFixture(null, 0, async (fixture) => {
      const lavish = fakeLavish(join(fixture.home, "boards"))
      const chat = boardChat(fixture, lavish)
      await parkTwo(fixture, chat.call)
      const cards = [
        { question: "question-4", options: ["keep three", "drop them"], recommended: "keep three" },
        { question: "question-5", options: ["30s", "2m"], recommended: "30s" }
      ]
      expect(await chat.call("orc_decision_board", { id: "orc-1", cards })).toBe("opened orc-1's decision board with 2 cards at http://127.0.0.1:4387/session/board-1. orc records each answer the captain sends from it, word for word, and keeps the task parked until every card is answered. The board opens only on this machine.")
      lavish.answer("question-4", "drop them")
      await until(() => chat.boardLines().length === 1)
      expect(chat.boardLines()).toEqual(["From orc-1's decision board, Keep the retries? drop them: answered question-4 on orc-1, and it stays parked for question-5"])
      expect((await chat.held())?.parked).toEqual({
        branch: "orc/orc-1",
        questions: [{ id: "question-4", answer: { words: "drop them" } }, { id: "question-5", answer: null }]
      })
      expect(lavish.ended).toEqual([])
      lavish.answer("question-5", "2m")
      await until(() => chat.boardLines().length === 3)
      expect(chat.boardLines().slice(1)).toEqual([
        "From orc-1's decision board, Which timeout? 2m: answered question-5 on orc-1, so the beat resumes it on orc/orc-1",
        "orc-1 is no longer parked, so orc closed its decision board"
      ])
      expect((await chat.held())?.parked?.questions.map((question) => question.answer)).toEqual([{ words: "drop them" }, { words: "2m" }])
      await chat.session.stopBoards()
    })
  }, 60_000)

  test("a session ended in Lavish stops the reading and leaves the task held instead of polling it again or ending it twice", async () => {
    await withFixture(null, 0, async (fixture) => {
      const lavish = fakeLavish(join(fixture.home, "boards"))
      const chat = boardChat(fixture, lavish)
      await holdTwo(chat.call)
      await chat.call("orc_decision_board", twoCards)
      await until(() => lavish.polls() === 1)
      lavish.send({ kind: "closed", status: "ended" })
      await until(() => chat.boardLines().length === 1)
      expect(chat.boardLines()).toEqual(["orc-1's decision board's Lavish session is ended, so orc stopped reading it; open it again to answer the rest"])
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
      const lavish = fakeLavish(join(fixture.home, "boards"))
      const chat = boardChat(fixture, lavish)
      await holdTwo(chat.call)
      await chat.call("orc_decision_board", twoCards)
      const page = join(fixture.home, "boards", "orc-1", "board.html")
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
      const lavish = fakeLavish(join(fixture.home, "boards"))
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
      const lavish = fakeLavish(join(fixture.home, "boards"))
      const chat = boardChat(fixture, lavish)
      await holdTwo(chat.call)
      await chat.call("orc_decision_board", twoCards)
      lavish.answer("question-1", "SOAP")
      await until(() => chat.boardLines().length === 1)
      expect(chat.boardLines()).toEqual(["orc-1's decision board sent an answer that matches none of its cards, so orc recorded nothing: question-1: SOAP"])
      expect((await chat.held())?.hold?.questions.map((question) => question.answer)).toEqual([null, null])
      await chat.session.stopBoards()
    })
  }, 60_000)

  test("a board that leaves out an open question is refused instead of opened partly", async () => {
    await withFixture(null, 0, async (fixture) => {
      const lavish = fakeLavish(join(fixture.home, "boards"))
      const chat = boardChat(fixture, lavish)
      await holdTwo(chat.call)
      const refused = await chat.call("orc_decision_board", { id: "orc-1", cards: [twoCards.cards[0]] }).then(String, refusal)
      expect(refused).toBe("orc-1 is held on question-1, question-2, so its board takes one card for each of those, not question-1")
      expect(lavish.opened).toEqual([])
    })
  }, 60_000)

  test("a recommendation outside a card's options is refused instead of shown as recommended", async () => {
    await withFixture(null, 0, async (fixture) => {
      const lavish = fakeLavish(join(fixture.home, "boards"))
      const chat = boardChat(fixture, lavish)
      await holdTwo(chat.call)
      const cards = [twoCards.cards[0], { question: "question-2", options: ["eu-west"], recommended: "mars" }]
      const refused = await chat.call("orc_decision_board", { id: "orc-1", cards }).then(String, refusal)
      expect(refused).toBe("a card on orc-1's board recommends mars, which is not one of its options: eu-west")
    })
  }, 60_000)

  test("a hold with a reason and no questions takes one card whose answer releases it instead of needing a question id", async () => {
    await withFixture(null, 0, async (fixture) => {
      const lavish = fakeLavish(join(fixture.home, "boards"))
      const chat = boardChat(fixture, lavish)
      await chat.call("orc_backlog_add", { project: "orc", task: "# Pick the API\n" })
      await chat.call("orc_backlog_hold", { id: "orc-1", reason: "REST or gRPC?" })
      await chat.call("orc_decision_board", { id: "orc-1", cards: [{ options: ["REST", "gRPC"], recommended: "REST" }] })
      lavish.answer("reason", "gRPC")
      await until(() => chat.boardLines().length === 2)
      expect(chat.boardLines()).toEqual([
        "From orc-1's decision board, REST or gRPC? gRPC: answered orc-1, so the beat may start it",
        "orc-1 is no longer held, so orc closed its decision board"
      ])
      expect((await chat.held())?.hold?.answer).toEqual({ words: "gRPC" })
    })
  }, 60_000)
})
