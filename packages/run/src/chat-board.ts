import { Effect, Fiber, FileSystem, Schema } from "effect"
import { type BacklogTask, type Decision, openDecision } from "./chat-backlog"
import { fileSystemLayer } from "./chat-command"
import { ChatToolError } from "./chat-error"
import type { BoardCard, BoardInput } from "./chat-inputs"
import type { BoardLauncher, BoardPrompt } from "./chat-lavish"
import { answerArgs, answerTag, answerWords, BoardAnswer, type BoardCardRecord, boardHtml, BoardRecord, cardKey } from "./chat-board-page"

export interface BoardHost {
  readonly dir: string | null
  readonly launcher: BoardLauncher
  readonly now: () => Date
  readonly orc: (args: ReadonlyArray<string>) => Effect.Effect<string, ChatToolError>
  readonly tasks: Effect.Effect<ReadonlyArray<BacklogTask>, ChatToolError>
  readonly say: (line: string) => void
}

export interface Boards {
  readonly open: (input: BoardInput) => Effect.Effect<string, ChatToolError>
  readonly listOpen: Effect.Effect<void>
  readonly stop: Effect.Effect<void>
}

export const boardsVar = "ORC_CHAT_BOARDS"

const refuse = (message: string): Effect.Effect<never, ChatToolError> => Effect.fail(new ChatToolError({ message }))

const decodeRecord = Schema.decodeEffect(Schema.fromJsonString(BoardRecord))
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(BoardRecord))
const decodeAnswer = Schema.decodeUnknownEffect(BoardAnswer)

const checkedCard = (task: string, card: BoardCard, target: BoardCardRecord["target"], text: string): Effect.Effect<BoardCardRecord, ChatToolError> => {
  if (new Set(card.options).size !== card.options.length) {
    return refuse("a card on " + task + "'s board lists an option twice: " + card.options.join(", "))
  }
  if (!card.options.includes(card.recommended)) {
    return refuse("a card on " + task + "'s board recommends " + card.recommended + ", which is not one of its options: " + card.options.join(", "))
  }
  return Effect.succeed({ target, text, options: card.options, recommended: card.recommended })
}

type BoardCards = BoardRecord["cards"]

const cardsFor = (task: Decision, cards: BoardInput["cards"]): Effect.Effect<BoardCards, ChatToolError> => {
  const [first, ...rest] = cards
  if (task.questions.length === 0) {
    if (rest.length > 0 || first.question !== undefined) {
      return refuse(task.id + " is held with a reason and no questions, so its board takes one card with no question")
    }
    return checkedCard(task.id, first, { kind: "reason" }, task.reason).pipe(Effect.map((card): BoardCards => [card]))
  }
  const open = task.questions.filter((question) => question.answer === null)
  const named = cards.map((card) => card.question ?? "")
  const fits = named.length === open.length && new Set(named).size === named.length && open.every((question) => named.includes(question.id))
  if (!fits) {
    return refuse(task.id + " is " + task.waits + " on " + open.map((question) => question.id).join(", ") + ", so its board takes one card for each of those, not " + named.map((id) => id === "" ? "a card with no question" : id).join(", "))
  }
  const textOf = (id: string): string => open.find((question) => question.id === id)?.text ?? ""
  return Effect.all([
    checkedCard(task.id, first, { kind: "question", id: named[0] }, textOf(named[0])),
    ...rest.map((card, index) => checkedCard(task.id, card, { kind: "question", id: named[index + 1] }, textOf(named[index + 1])))
  ])
}

// A reason card is answered exactly when its task stops being held, so on an open board it is never answered.
const recordedWords = (task: Decision) => (card: BoardCardRecord): string | null =>
  card.target.kind === "reason" ? null : task.questions.find((question) => question.id === cardKey(card.target))?.answer?.words ?? null

const waitingOn = (record: BoardRecord, task: Decision): string =>
  record.cards.filter((card) => recordedWords(task)(card) === null).map((card) => cardKey(card.target)).join(", ")

const fileError = (error: { readonly message: string }): ChatToolError => new ChatToolError({ message: "orc chat cannot keep its decision boards: " + error.message })

const boardFile = (dir: string, name: "board.html" | "board.json"): string => dir + "/" + name

const writeAtomic = (file: string, text: string): Effect.Effect<void, ChatToolError> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(file + ".tmp", text)
    yield* fs.rename(file + ".tmp", file)
  }).pipe(Effect.provide(fileSystemLayer), Effect.mapError(fileError))

const makeBoardDir = (dir: string): Effect.Effect<void, ChatToolError> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(dir, { recursive: true })
  }).pipe(Effect.provide(fileSystemLayer), Effect.mapError(fileError))

const boardDirs = (root: string): Effect.Effect<ReadonlyArray<string>, ChatToolError> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readDirectory(root)
  }).pipe(
    Effect.provide(fileSystemLayer),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
    Effect.mapError(fileError),
    Effect.map((entries) => entries.toSorted((left, right) => left.localeCompare(right)).map((entry) => root + "/" + entry))
  )

const readRecord = (dir: string): Effect.Effect<BoardRecord, ChatToolError> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(boardFile(dir, "board.json"))
  }).pipe(
    Effect.provide(fileSystemLayer),
    Effect.mapError(fileError),
    Effect.flatMap((text) => decodeRecord(text).pipe(Effect.mapError((error) => fileError({ message: boardFile(dir, "board.json") + ": " + error.message }))))
  )

const writeBoard = (dir: string, record: BoardRecord, task: Decision): Effect.Effect<void, ChatToolError> =>
  Effect.gen(function*() {
    yield* makeBoardDir(dir)
    const json = yield* encodeRecord(record).pipe(Effect.mapError(fileError))
    yield* writeAtomic(boardFile(dir, "board.json"), json)
    yield* writeAtomic(boardFile(dir, "board.html"), boardHtml(record, recordedWords(task)))
  })

const waitingTask = (host: BoardHost, id: string): Effect.Effect<Decision | null, ChatToolError> =>
  host.tasks.pipe(Effect.map((tasks) => tasks.find((task) => task.id === id) ?? null), Effect.map((task) => task === null ? null : openDecision(task)))

const recordPrompt = (host: BoardHost, record: BoardRecord, prompt: BoardPrompt): Effect.Effect<string> =>
  Effect.gen(function*() {
    if (prompt.tag !== answerTag) {
      host.say("On " + record.task + "'s decision board the captain wrote: " + prompt.text)
      return "orc passed this to the chat"
    }
    const answer = yield* decodeAnswer(prompt.data).pipe(Effect.orElseSucceed(() => null))
    const card = answer === null ? undefined : record.cards.find((candidate) => cardKey(candidate.target) === answer.card)
    if (answer === null || card === undefined || !card.options.includes(answer.answer)) {
      const line = record.task + "'s decision board sent an answer that matches none of its cards, so orc recorded nothing: " + prompt.text
      host.say(line)
      return line
    }
    const words = answerWords(answer)
    const said = yield* host.orc(answerArgs(record.task, card.target, words)).pipe(
      Effect.catchTag("ChatToolError", (error) => Effect.succeed("orc recorded nothing: " + error.message))
    )
    host.say("From " + record.task + "'s decision board, " + card.text + " " + words + ": " + said)
    return said
  })

type Reading = "read again" | "done"

const refreshed = (host: BoardHost, dir: string, record: BoardRecord, reply: string): Effect.Effect<Reading, ChatToolError> =>
  Effect.gen(function*() {
    const task = yield* waitingTask(host, record.task)
    const page = boardFile(dir, "board.html")
    const replied = host.launcher.reply(page, reply).pipe(Effect.catchTag("ChatToolError", () => Effect.void))
    if (task === null) {
      yield* replied.pipe(Effect.andThen(host.launcher.end(page)), Effect.catchTag("ChatToolError", () => Effect.void))
      host.say(record.task + " is no longer " + record.waits + ", so orc closed its decision board")
      return "done"
    }
    yield* writeAtomic(page, boardHtml(record, recordedWords(task)))
    yield* replied
    return "read again"
  })

const watchOnce = (host: BoardHost, dir: string): Effect.Effect<Reading, ChatToolError> =>
  Effect.gen(function*() {
    const poll = yield* host.launcher.poll(boardFile(dir, "board.html"))
    if (poll.kind === "waiting") {
      return "read again"
    }
    const record = yield* readRecord(dir)
    if (poll.kind === "closed") {
      host.say(record.task + "'s decision board's Lavish session is " + poll.status + ", so orc stopped reading it; open it again to answer the rest")
      return "done"
    }
    const said = yield* Effect.forEach(poll.prompts, (prompt) => recordPrompt(host, record, prompt))
    return yield* refreshed(host, dir, record, said.join("\n\n"))
  })

const openedLine = (record: BoardRecord, cards: number, url: string): string =>
  "opened " + record.task + "'s decision board with " + cards + " cards at " + url +
  ". orc records each answer the captain sends from it, word for word, and keeps the task " + record.waits + " until every card is answered."

export const decisionBoards = (host: BoardHost): Boards => {
  const watching = new Map<string, Fiber.Fiber<void>>()
  const boardDir = (task: string): Effect.Effect<string, ChatToolError> =>
    host.dir === null ? refuse("orc chat names its decision board folder in " + boardsVar + ", so open a board from inside orc chat") : Effect.succeed(host.dir + "/" + task)

  const watch = (task: string, dir: string): void => {
    if (watching.has(task)) {
      return
    }
    const loop = Effect.gen(function*() {
      while ((yield* watchOnce(host, dir)) === "read again") {
        yield* Effect.yieldNow
      }
    }).pipe(
      Effect.catchTag("ChatToolError", (error) => Effect.sync(() => host.say("orc stopped reading " + task + "'s decision board: " + error.message))),
      Effect.ensuring(Effect.sync(() => watching.delete(task)))
    )
    // The fiber yields before its first poll, so it is in the map before it can remove itself.
    watching.set(task, Effect.runFork(Effect.yieldNow.pipe(Effect.andThen(loop))))
  }

  const open = (input: BoardInput): Effect.Effect<string, ChatToolError> =>
    Effect.gen(function*() {
      const dir = yield* boardDir(input.id)
      const task = yield* waitingTask(host, input.id)
      if (task === null) {
        return yield* refuse(input.id + " is neither held nor parked for the captain, so it takes no decision board")
      }
      const cards = yield* cardsFor(task, input.cards)
      const record: BoardRecord = { task: task.id, title: task.title, waits: task.waits, reason: task.reason, openedAt: host.now().toISOString(), cards }
      yield* writeBoard(dir, record, task)
      const url = yield* host.launcher.open(boardFile(dir, "board.html"))
      watch(task.id, dir)
      return openedLine(record, cards.length, url)
    })

  const listOne = (dir: string): Effect.Effect<void, ChatToolError> =>
    Effect.gen(function*() {
      const record = yield* readRecord(dir)
      const task = yield* waitingTask(host, record.task)
      if (task === null) {
        return
      }
      const url = yield* host.launcher.open(boardFile(dir, "board.html"))
      host.say(task.id + " " + task.title + " has a decision board open since " + record.openedAt + " at " + url + ", waiting on " + waitingOn(record, task))
      watch(task.id, dir)
    })

  const listOpen = (host.dir === null ? Effect.succeed([]) : boardDirs(host.dir)).pipe(
    Effect.flatMap((dirs) =>
      Effect.forEach(dirs, (dir) =>
        listOne(dir).pipe(Effect.catchTag("ChatToolError", (error) => Effect.sync(() => host.say("orc chat cannot list the decision board in " + dir + ": " + error.message)))), { discard: true })
    ),
    Effect.catchTag("ChatToolError", (error) => Effect.sync(() => host.say(error.message)))
  )

  const stop = Effect.suspend(() => Effect.forEach([...watching.values()], Fiber.interrupt, { discard: true }))

  return { open, listOpen, stop }
}
