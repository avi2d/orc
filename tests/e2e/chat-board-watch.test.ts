import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { withFixture } from "./chat-helpers"
import { boardChat, fakeLavish, holdTwo, openedAt, savedBoardId, twoCards, until } from "./chat-board-helpers"

describe("orc chat decision boards", () => {
  test("a board answer for a question answered elsewhere records nothing instead of overwriting it", async () => {
    await withFixture(null, 0, async (fixture) => {
      const lavish = fakeLavish(join(fixture.home, "boards"))
      const chat = boardChat(fixture, lavish)
      await holdTwo(chat.call)
      await chat.call("orc_decision_board", twoCards)
      await chat.call("orc_backlog_answer", { id: "orc-1", question: "question-1", words: "REST" })
      lavish.answer("question-1", "gRPC")
      await until(() => chat.boardLines().length === 1)
      expect(chat.boardLines()).toEqual(["orc-1's decision board no longer describes its current decision, so orc recorded nothing: question-1: gRPC"])
      expect((await chat.held())?.hold?.questions.map((question) => question.answer)).toEqual([{ words: "REST" }, null])
      await until(() => readFileSync(join(fixture.home, "boards", "orc-1", "board.html"), "utf8").includes("Recorded: <strong>REST</strong>"))
      await chat.session.stopBoards()
    })
  }, 60_000)

  test("the chat start lists each board whose task is still held, with the time it opened, instead of none or a released one", async () => {
    await withFixture(null, 0, async (fixture) => {
      const first = fakeLavish(join(fixture.home, "boards"))
      const before = boardChat(fixture, first)
      await holdTwo(before.call)
      await before.call("orc_decision_board", twoCards)
      first.answer("question-1", "REST")
      await until(() => before.boardLines().length === 1)
      await before.session.stopBoards()
      await mkdir(join(fixture.home, "boards", "orc-9"), { recursive: true })
      await writeFile(join(fixture.home, "boards", "orc-9", "board.json"), JSON.stringify({
        task: "orc-9", title: "Gone", waits: "held", reason: "x", openedAt: openedAt.toISOString(), board: "board-gone", cards: [{ target: { kind: "reason" }, text: "x", options: ["a"], recommended: "a" }]
      }))
      const second = fakeLavish(join(fixture.home, "boards"))
      const after = boardChat(fixture, second)
      await after.session.listBoards()
      expect(after.boardLines()).toEqual([
        "orc-1 Pick the API has a decision board open since 2026-11-03T09:30:00.000Z, waiting on question-2"
      ])
      expect(second.opened).toEqual([])
      expect(second.polls()).toBe(0)
      await after.call("orc_decision_board", { id: "orc-1", cards: [twoCards.cards[1]] })
      expect(second.opened).toEqual([join(fixture.home, "boards", "orc-1", "board.html")])
      second.answer("question-2", "eu-west")
      await until(() => after.boardLines().length === 3)
      expect(after.boardLines()[1]).toBe("From orc-1's decision board, Which region? eu-west: answered question-2 on orc-1, so the beat may start it")
    })
  }, 60_000)

  test("an answer queued from an earlier board records nothing instead of landing on the newer decision", async () => {
    await withFixture(null, 0, async (fixture) => {
      const lavish = fakeLavish(join(fixture.home, "boards"))
      const chat = boardChat(fixture, lavish)
      await holdTwo(chat.call)
      await chat.call("orc_decision_board", twoCards)
      const before = savedBoardId(join(fixture.home, "boards"))
      await chat.call("orc_decision_board", twoCards)
      lavish.send({ kind: "feedback", prompts: [{ tag: "orc-board-answer", text: "REST or gRPC?: gRPC", data: { board: before, card: "question-1", answer: "gRPC" } }] })
      await until(() => chat.boardLines().some((line) => line.includes("no longer describes its current decision")))
      expect(chat.boardLines()).toEqual(["orc-1's decision board no longer describes its current decision, so orc recorded nothing: REST or gRPC?: gRPC"])
      expect((await chat.held())?.hold?.questions.map((question) => question.answer)).toEqual([null, null])
      await chat.session.stopBoards()
    })
  }, 60_000)

  test("answers recorded outside the board close its page and session on the next refresh instead of leaving it open", async () => {
    await withFixture(null, 0, async (fixture) => {
      const lavish = fakeLavish(join(fixture.home, "boards"))
      const chat = boardChat(fixture, lavish)
      await holdTwo(chat.call)
      await chat.call("orc_decision_board", twoCards)
      await chat.call("orc_backlog_answer", { id: "orc-1", question: "question-1", words: "gRPC" })
      await chat.call("orc_backlog_answer", { id: "orc-1", question: "question-2", words: "us-east" })
      await chat.session.reconcileBoards()
      const page = await readFile(join(fixture.home, "boards", "orc-1", "board.html"), "utf8")
      expect(page).toContain("Every card is answered.")
      expect(page).toContain("Recorded: <strong>gRPC</strong>")
      expect(page).toContain("Recorded: <strong>us-east</strong>")
      expect(lavish.ended).toEqual([join(fixture.home, "boards", "orc-1", "board.html")])
      expect(chat.boardLines()).toEqual(["orc-1 is no longer held, so orc closed its decision board"])
      await chat.session.stopBoards()
    })
  }, 60_000)

  test("a board released while the chat was away gets its completed page at the next start instead of keeping open cards", async () => {
    await withFixture(null, 0, async (fixture) => {
      const lavish = fakeLavish(join(fixture.home, "boards"))
      const chat = boardChat(fixture, lavish)
      await holdTwo(chat.call)
      await chat.call("orc_decision_board", twoCards)
      await chat.call("orc_backlog_answer", { id: "orc-1", question: "question-1", words: "gRPC" })
      await chat.call("orc_backlog_answer", { id: "orc-1", question: "question-2", words: "us-east" })
      await chat.session.stopBoards()
      const next = boardChat(fixture, fakeLavish(join(fixture.home, "boards")))
      await next.session.listBoards()
      expect(next.boardLines()).toEqual([])
      expect(await readFile(join(fixture.home, "boards", "orc-1", "board.html"), "utf8")).toContain("Every card is answered.")
      await next.session.stopBoards()
    })
  }, 60_000)

  test("a held board whose hold is answered and whose task parks renders its completed page instead of asking to open it again", async () => {
    await withFixture(null, 0, async (fixture) => {
      const lavish = fakeLavish(join(fixture.home, "boards"))
      const chat = boardChat(fixture, lavish)
      await holdTwo(chat.call)
      await chat.call("orc_decision_board", twoCards)
      await chat.call("orc_backlog_answer", { id: "orc-1", question: "question-1", words: "gRPC" })
      await chat.call("orc_backlog_answer", { id: "orc-1", question: "question-2", words: "us-east" })
      const file = join(fixture.home, "backlog", "new", "orc-1.md")
      const text = await readFile(file, "utf8")
      const end = text.indexOf("\n---\n", 4)
      const questions = [{ id: "question-4", text: "Keep the retries?" }]
      await writeFile(file + ".tmp", text.slice(0, end) + "\nparked_branch: \"orc/orc-1\"\nparked_questions: " + JSON.stringify(questions) + text.slice(end))
      await rename(file + ".tmp", file)
      await chat.session.reconcileBoards()
      const page = await readFile(join(fixture.home, "boards", "orc-1", "board.html"), "utf8")
      expect(page).toContain("Every card is answered.")
      expect(page).toContain("Recorded: <strong>gRPC</strong>")
      expect(chat.boardLines()).toEqual(["orc-1 is no longer held, so orc closed its decision board"])
      await chat.session.stopBoards()
      const next = boardChat(fixture, fakeLavish(join(fixture.home, "boards")))
      await next.session.listBoards()
      expect(next.boardLines()).toEqual([])
      expect(await readFile(join(fixture.home, "boards", "orc-1", "board.html"), "utf8")).toContain("Every card is answered.")
      await next.session.stopBoards()
    })
  }, 60_000)

  test("a refresh while cards are still open keeps the board watched and shows the outside answer instead of dropping later ones", async () => {
    await withFixture(null, 0, async (fixture) => {
      const lavish = fakeLavish(join(fixture.home, "boards"))
      const chat = boardChat(fixture, lavish)
      await holdTwo(chat.call)
      await chat.call("orc_decision_board", twoCards)
      await chat.call("orc_backlog_answer", { id: "orc-1", question: "question-1", words: "gRPC" })
      await chat.session.reconcileBoards()
      expect(await readFile(join(fixture.home, "boards", "orc-1", "board.html"), "utf8")).toContain("Recorded: <strong>gRPC</strong>")
      expect(chat.boardLines()).toEqual([])
      lavish.answer("question-2", "us-east")
      await until(() => chat.boardLines().some((line) => line.includes("answered question-2 on orc-1")))
      expect((await chat.held())?.hold?.questions.map((question) => question.answer)).toEqual([{ words: "gRPC" }, { words: "us-east" }])
      await chat.session.stopBoards()
    })
  }, 60_000)
})
