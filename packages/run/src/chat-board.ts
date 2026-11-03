import { Effect, Fiber, FileSystem, Schema, Semaphore } from "effect"
import { decisionFor, type BacklogTask, type Decision, openDecision } from "./chat-backlog"
import { answeredAlready, completedWords, matchesRecord } from "./chat-board-bind"
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
  readonly reconcileWatched: Effect.Effect<void>
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

const cardsFor = (task: Decision, cards: BoardInput["cards"]): Effect.Effect<BoardRecord["cards"], ChatToolError> => {
  const [first, ...rest] = cards
  if (task.questions.length === 0) {
    if (rest.length > 0 || first.question !== undefined) {
      return refuse(task.id + " is held with a reason and no questions, so its board takes one card with no question")
    }
    return checkedCard(task.id, first, { kind: "reason" }, task.reason).pipe(Effect.map((card): BoardRecord["cards"] => [card]))
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

const recordedWords = (task: Decision) => (card: BoardCardRecord): string | null =>
  card.target.kind === "reason" ? null : task.questions.find((question) => question.id === cardKey(card.target))?.answer?.words ?? null

const waitingOn = (record: BoardRecord, task: Decision): string =>
  record.cards.filter((card) => recordedWords(task)(card) === null).map((card) => cardKey(card.target)).join(", ")

const fileError = (error: { readonly message: string }): ChatToolError => new ChatToolError({ message: "orc chat cannot keep its decision boards: " + error.message })

const boardFile = (dir: string, name: "board.html" | "board.json"): string => dir + "/" + name

const writeAtomic = (file: string, text: string): Effect.Effect<void, ChatToolError> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const tmp = file + ".tmp." + crypto.randomUUID()
    yield* fs.writeFileString(tmp, text)
    yield* fs.rename(tmp, file)
  }).pipe(Effect.provide(fileSystemLayer), Effect.mapError(fileError))

const writePageIfChanged = (file: string, text: string): Effect.Effect<void, ChatToolError> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const prior = yield* fs.readFileString(file).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
      Effect.mapError(fileError)
    )
    if (prior !== text) {
      yield* writeAtomic(file, text)
    }
  }).pipe(Effect.provide(fileSystemLayer))

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

const openFrom = (tasks: ReadonlyArray<BacklogTask>, id: string): Decision | null => {
  const task = tasks.find((candidate) => candidate.id === id) ?? null
  return task === null ? null : openDecision(task)
}

const rawFrom = (tasks: ReadonlyArray<BacklogTask>, id: string): BacklogTask | null =>
  tasks.find((candidate) => candidate.id === id) ?? null

const boundFrom = (tasks: ReadonlyArray<BacklogTask>, record: BoardRecord): Decision | null => {
  const task = rawFrom(tasks, record.task)
  if (task === null) {
    return null
  }
  const bound = decisionFor(task, record.waits)
  return bound !== null && matchesRecord(bound, record) ? bound : null
}

const staleLine = (record: BoardRecord, text: string): string =>
  record.task + "'s decision board no longer describes its current decision, so orc recorded nothing: " + text

const unmatchedLine = (record: BoardRecord, text: string): string =>
  record.task + "'s decision board sent an answer that matches none of its cards, so orc recorded nothing: " + text

type MatchedAnswer =
  | { readonly kind: "matched"; readonly card: BoardCardRecord; readonly answer: typeof BoardAnswer.Type }
  | { readonly kind: "refused"; readonly line: string }

const matchAnswer = (record: BoardRecord, prompt: BoardPrompt): Effect.Effect<MatchedAnswer> =>
  decodeAnswer(prompt.data).pipe(
    Effect.map((answer): MatchedAnswer => {
      if (answer.board !== record.board) {
        return { kind: "refused", line: staleLine(record, prompt.text) }
      }
      const card = record.cards.find((candidate) => cardKey(candidate.target) === answer.card)
      return card === undefined || !card.options.includes(answer.answer)
        ? { kind: "refused", line: unmatchedLine(record, prompt.text) }
        : { kind: "matched", card, answer }
    }),
    Effect.orElseSucceed((): MatchedAnswer => ({ kind: "refused", line: unmatchedLine(record, prompt.text) }))
  )

const staleRefusal = (tasks: ReadonlyArray<BacklogTask>, record: BoardRecord, card: BoardCardRecord, text: string): string | null => {
  const bound = boundFrom(tasks, record)
  return bound === null || answeredAlready(bound, card) ? staleLine(record, text) : null
}

const recordPrompt = (host: BoardHost, record: BoardRecord, prompt: BoardPrompt): Effect.Effect<string> =>
  Effect.gen(function*() {
    if (prompt.tag !== answerTag) {
      host.say("On " + record.task + "'s decision board the captain wrote: " + prompt.text)
      return "orc passed this to the chat"
    }
    const matched = yield* matchAnswer(record, prompt)
    if (matched.kind === "refused") {
      host.say(matched.line)
      return matched.line
    }
    const { card, answer } = matched
    const tasks = yield* host.tasks.pipe(Effect.catchTag("ChatToolError", (error) => Effect.succeed("orc recorded nothing: " + error.message)))
    if (typeof tasks === "string") {
      host.say(tasks)
      return tasks
    }
    const refusal = staleRefusal(tasks, record, card, prompt.text)
    if (refusal !== null) {
      host.say(refusal)
      return refusal
    }
    const words = answerWords(answer)
    const said = yield* host.orc(answerArgs(record.task, card.target, words)).pipe(
      Effect.catchTag("ChatToolError", (error) => Effect.succeed("orc recorded nothing: " + error.message))
    )
    host.say("From " + record.task + "'s decision board, " + card.text + " " + words + ": " + said)
    return said
  })

type Reading = "read again" | "done"

const closedBoardLine = (record: BoardRecord): string =>
  record.task + " is no longer " + record.waits + ", so orc closed its decision board"

const staleBoardLine = (record: BoardRecord): string =>
  record.task + "'s decision board no longer describes its current decision, so orc stopped reading it; open it again to answer the rest"

const refreshPage = (tasks: ReadonlyArray<BacklogTask>, dir: string, record: BoardRecord): Effect.Effect<"closed" | "stale" | "current", ChatToolError> =>
  Effect.gen(function*() {
    const page = boardFile(dir, "board.html")
    const raw = rawFrom(tasks, record.task)
    if (raw === null || decisionFor(raw, record.waits) === null) {
      if (raw !== null) {
        yield* writePageIfChanged(page, boardHtml(record, completedWords(record, raw)))
      }
      return "closed"
    }
    const bound = boundFrom(tasks, record)
    if (bound === null) {
      return "stale"
    }
    yield* writePageIfChanged(page, boardHtml(record, recordedWords(bound)))
    return "current"
  })

const refreshed = (host: BoardHost, tasks: ReadonlyArray<BacklogTask>, dir: string, record: BoardRecord, reply: string): Effect.Effect<Reading, ChatToolError> =>
  Effect.gen(function*() {
    const page = boardFile(dir, "board.html")
    const replied = host.launcher.reply(page, reply).pipe(Effect.catchTag("ChatToolError", () => Effect.void))
    const ended = replied.pipe(Effect.andThen(host.launcher.end(page)), Effect.catchTag("ChatToolError", () => Effect.void))
    const state = yield* refreshPage(tasks, dir, record)
    if (state === "closed") {
      yield* ended
      host.say(closedBoardLine(record))
      return "done"
    }
    if (state === "stale") {
      yield* ended
      host.say(staleBoardLine(record))
      return "done"
    }
    yield* replied
    return "read again"
  })

const watchOnce = (host: BoardHost, dir: string, sem: Semaphore.Semaphore): Effect.Effect<Reading, ChatToolError> =>
  Effect.gen(function*() {
    const poll = yield* host.launcher.poll(boardFile(dir, "board.html"))
    if (poll.kind === "waiting") {
      return "read again"
    }
    return yield* sem.withPermits(1)(Effect.gen(function*() {
      const record = yield* readRecord(dir)
      if (poll.kind === "closed") {
        host.say(record.task + "'s decision board's Lavish session is " + poll.status + ", so orc stopped reading it; open it again to answer the rest")
        return "done"
      }
      const said = yield* Effect.forEach(poll.prompts, (prompt) => recordPrompt(host, record, prompt))
      const tasks = yield* host.tasks
      return yield* refreshed(host, tasks, dir, record, said.join("\n\n"))
    }))
  })

const openedLine = (record: BoardRecord, cards: number, url: string, networkWarning: string): string => {
  const base = "opened " + record.task + "'s decision board with " + cards + " cards at " + url +
    ". orc records each answer the captain sends from it, word for word, and keeps the task " + record.waits + " until every card is answered."
  if (networkWarning !== "") {
    return base + " " + networkWarning
  }
  const host = new URL(url).hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase()
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
    return base + " The board opens only on this machine."
  }
  return base + " Anyone on the same network who holds the link can open it and submit answers, which orc records as the captain's, because the page has no login."
}

type BoardFibers = Map<string, { readonly dir: string; readonly fiber: Fiber.Fiber<void>; readonly sem: Semaphore.Semaphore }>

const stopWatching = (host: BoardHost, fibers: BoardFibers, task: string): Effect.Effect<void> =>
  Effect.gen(function*() {
    const entry = fibers.get(task)
    if (entry === undefined) {
      return
    }
    fibers.delete(task)
    yield* Fiber.interrupt(entry.fiber)
  })

const reconcileOne = (host: BoardHost, fibers: BoardFibers, task: string, dir: string): Effect.Effect<void> =>
  Effect.gen(function*() {
    const entry = fibers.get(task)
    if (entry === undefined) {
      return
    }
    yield* entry.sem.withPermits(1)(Effect.gen(function*() {
      if (fibers.get(task) !== entry) {
        return
      }
      const record = yield* readRecord(dir)
      const tasks = yield* host.tasks
      const state = yield* refreshPage(tasks, dir, record)
      if (state === "current") {
        return
      }
      yield* host.launcher.end(boardFile(dir, "board.html")).pipe(Effect.catchTag("ChatToolError", () => Effect.void))
      host.say(state === "closed" ? closedBoardLine(record) : staleBoardLine(record))
      yield* stopWatching(host, fibers, task)
    }).pipe(
      Effect.catchTag("ChatToolError", (error) =>
        Effect.sync(() => host.say("orc stopped reading " + task + "'s decision board: " + error.message)).pipe(
          Effect.andThen(stopWatching(host, fibers, task))
        ))
    ))
  })

export const decisionBoards = (host: BoardHost): Boards => {
  const fibers: BoardFibers = new Map()

  const watch = (task: string, dir: string, sem: Semaphore.Semaphore): void => {
    if (fibers.has(task)) {
      return
    }
    const loop = Effect.gen(function*() {
      while ((yield* watchOnce(host, dir, sem)) === "read again") {
        yield* Effect.yieldNow
      }
    }).pipe(
      Effect.catchTag("ChatToolError", (error) => Effect.sync(() => host.say("orc stopped reading " + task + "'s decision board: " + error.message))),
      Effect.ensuring(Effect.sync(() => fibers.delete(task)))
    )
    fibers.set(task, { dir, fiber: Effect.runFork(Effect.yieldNow.pipe(Effect.andThen(loop))), sem })
  }

  const reconcileWatched: Effect.Effect<void> = Effect.suspend(() =>
    Effect.forEach([...fibers.keys()], (task) => {
      const entry = fibers.get(task)
      return entry === undefined ? Effect.void : reconcileOne(host, fibers, task, entry.dir)
    }, { discard: true })
  )

  const open = (input: BoardInput): Effect.Effect<string, ChatToolError> =>
    Effect.gen(function*() {
      const dir = host.dir === null
        ? yield* refuse("orc chat names its decision board folder in " + boardsVar + ", so open a board from inside orc chat")
        : host.dir + "/" + input.id
      const tasks = yield* host.tasks
      const task = openFrom(tasks, input.id)
      if (task === null) {
        return yield* refuse(input.id + " is neither held nor parked for the captain, so it takes no decision board")
      }
      const cards = yield* cardsFor(task, input.cards)
      const record: BoardRecord = { task: task.id, title: task.title, waits: task.waits, reason: task.reason, openedAt: host.now().toISOString(), board: crypto.randomUUID(), cards }
      const sem = fibers.get(task.id)?.sem ?? Semaphore.makeUnsafe(1)
      const session = yield* sem.withPermits(1)(Effect.gen(function*() {
        yield* writeBoard(dir, record, task)
        const opened = yield* host.launcher.open(boardFile(dir, "board.html"))
        watch(task.id, dir, sem)
        return opened
      }))
      return openedLine(record, cards.length, session.url, session.networkWarning)
    })

  const listOne = (dir: string): Effect.Effect<void, ChatToolError> =>
    Effect.gen(function*() {
      const record = yield* readRecord(dir)
      const tasks = yield* host.tasks
      const bound = boundFrom(tasks, record)
      if (bound !== null) {
        host.say(bound.id + " " + bound.title + " has a decision board open since " + record.openedAt + ", waiting on " + waitingOn(record, bound))
        return
      }
      const raw = rawFrom(tasks, record.task)
      if (raw === null || decisionFor(raw, record.waits) !== null) {
        return
      }
      yield* writePageIfChanged(boardFile(dir, "board.html"), boardHtml(record, completedWords(record, raw)))
    })

  const listOpen = (host.dir === null ? Effect.succeed([]) : boardDirs(host.dir)).pipe(
    Effect.flatMap((dirs) =>
      Effect.forEach(dirs, (dir) =>
        listOne(dir).pipe(Effect.catchTag("ChatToolError", (error) => Effect.sync(() => host.say("orc chat cannot list the decision board in " + dir + ": " + error.message)))), { discard: true })
    ),
    Effect.catchTag("ChatToolError", (error) => Effect.sync(() => host.say(error.message)))
  )

  const stop = Effect.suspend(() => Effect.forEach([...fibers.values()], (entry) => Fiber.interrupt(entry.fiber), { discard: true }))

  return { open, listOpen, reconcileWatched, stop }
}
