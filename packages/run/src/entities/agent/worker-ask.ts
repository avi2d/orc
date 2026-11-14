import { Effect, FileSystem, Option, Schema } from "effect"
import { readJsonFileIfPresent, writeWhole } from "../../shared/config/index"
import { AnswersFile, answersFileName, Asking, AskOption, askingFileName, hasBlockingQuestion, isBlockingQuestion, type OpenQuestion, type QuestionAnswer } from "../review-gate/index"
import { askFileStem, askSuffix, type AskReply, replySuffix } from "./orc-ask-extension"

const workerQuestionPattern = /^ask-(\d+)$/

export const isWorkerQuestion = (id: string): boolean => workerQuestionPattern.test(id)

export const longestAskWaitSeconds = 10 * 60

export const askExtensionSource = import.meta.dir + "/orc-ask-extension.ts"

interface WorkerAsk {
  readonly id: string
  readonly stem: string
  readonly question: string
  readonly text: string
  readonly options: ReadonlyArray<AskOption> | undefined
  readonly deadline: number | null
  readonly askedAt: string
  replied: boolean
}

export interface AskRunState {
  next: number
  asked: string | null
  timedOut: WorkerAsk | null
  readonly asks: Array<WorkerAsk>
  readonly recorded: Set<string>
}

export interface AskSetup {
  readonly runDir: string
  readonly askDir: string
  readonly extensionFile: string
  readonly waitSeconds: number
  readonly state: AskRunState
  readonly priorOpen: ReadonlyArray<OpenQuestion>
}

const askNumbers = (ids: ReadonlyArray<string>): Array<number> =>
  ids.flatMap((id) => {
    const found = workerQuestionPattern.exec(id)?.[1]
    return found === undefined ? [] : [Number(found)]
  })

export const askSetupFor = (
  runDir: string,
  piSessionDir: string,
  answerWaitSeconds: number,
  answered: ReadonlyArray<QuestionAnswer>,
  priorOpen: ReadonlyArray<OpenQuestion> = []
): AskSetup => ({
  runDir,
  askDir: piSessionDir + "/asks",
  extensionFile: piSessionDir + "/orc-ask.ts",
  waitSeconds: Math.min(answerWaitSeconds, longestAskWaitSeconds),
  state: {
    next: 1 + Math.max(0, ...askNumbers([...answered.map((answer) => answer.question), ...priorOpen.map((question) => question.id)])),
    asked: null,
    timedOut: null,
    asks: [],
    recorded: new Set()
  },
  priorOpen
})

export type AskedQuestion = OpenQuestion & { readonly asked: string }

const AskArgs = Schema.Struct({
  question: Schema.String,
  context: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(AskOption)),
  blocks: Schema.Boolean
})

type AskArgs = typeof AskArgs.Type

const decodeAskArgs = Schema.decodeUnknownOption(AskArgs)

const letter = (index: number): string => String.fromCharCode(65 + index)

const optionLine = (option: AskOption, index: number): string =>
  letter(index) + ") " + option.text + (option.picture === undefined ? "" : " (picture: " + option.picture + ")")

export const workerQuestionText = (args: Pick<AskArgs, "question" | "context" | "options">): string =>
  [
    args.question.trim(),
    ...(args.context === undefined || args.context.trim() === "" ? [] : ["Context: " + args.context.trim()]),
    ...(args.options ?? []).map(optionLine)
  ].join("\n")

export const liveAskQuestions = (setup: AskSetup): ReadonlyArray<OpenQuestion> =>
  setup.state.asks.filter((ask) => !ask.replied).map((ask) => ({
    id: ask.id,
    text: ask.text,
    asked: ask.askedAt,
    blocks: ask.deadline !== null
  }))

export interface WorkerAsks {
  readonly tick: Effect.Effect<void>
  readonly timedOut: () => AskedQuestion | null
}

const writeReply = (setup: AskSetup, ask: WorkerAsk, reply: AskReply): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  writeWhole(setup.askDir + "/" + ask.stem + replySuffix, JSON.stringify(reply))

export const openWorkerAsks = (fs: FileSystem.FileSystem, setup: AskSetup): WorkerAsks => {
  const askingFile = setup.runDir + "/" + askingFileName
  const answersFile = setup.runDir + "/" + answersFileName
  const provided = <A>(effect: Effect.Effect<A, never, FileSystem.FileSystem>): Effect.Effect<A> => Effect.provideService(effect, FileSystem.FileSystem, fs)
  const readAskFile = (stem: string): Effect.Effect<AskArgs | null> =>
    Effect.gen(function*() {
      const text = yield* provided(fs.readFileString(setup.askDir + "/" + stem + askSuffix).pipe(Effect.orElseSucceed(() => null)))
      if (text === null) {
        return null
      }
      const parsed: unknown = yield* Effect.try(() => JSON.parse(text) as unknown).pipe(Effect.orElseSucceed(() => null))
      if (parsed === null) {
        return null
      }
      const decoded = Option.getOrNull(decodeAskArgs(parsed))
      return decoded !== null && decoded.question.trim() !== "" ? decoded : null
    })
  const registerNew = (): Effect.Effect<boolean> =>
    Effect.gen(function*() {
      const shared = setup.state
      const names = yield* provided(fs.readDirectory(setup.askDir).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>)))
      let added = false
      for (const stem of names.filter((name) => name.endsWith(askSuffix)).map((name) => name.slice(0, -askSuffix.length)).toSorted()) {
        if (shared.asks.some((ask) => ask.stem === stem)) {
          continue
        }
        const decoded = yield* readAskFile(stem)
        if (decoded === null) {
          continue
        }
        const now = new Date().toISOString()
        shared.asks.push({
          id: "ask-" + String(shared.next),
          stem,
          question: decoded.question.trim(),
          text: workerQuestionText(decoded),
          options: decoded.options,
          deadline: decoded.blocks ? Date.parse(now) + setup.waitSeconds * 1000 : null,
          askedAt: now,
          replied: false
        })
        shared.next += 1
        added = true
      }
      return added
    })
  const writeAsking = (): Effect.Effect<boolean> =>
    Effect.gen(function*() {
      const shared = setup.state
      const previous = yield* provided(readJsonFileIfPresent(askingFile, Asking).pipe(Effect.orElseSucceed(() => null)))
      const asked = shared.asked ?? previous?.asked ?? new Date().toISOString()
      shared.asked = asked
      const open = shared.asks.filter((ask) => !ask.replied)
      const previousQuestions = (previous?.questions ?? []).filter((question) => !shared.asks.some((ask) => ask.id === question.id))
      const questions = [
        ...previousQuestions,
        ...open.map((ask) => ({
          id: ask.id,
          text: ask.text,
          ...(ask.options === undefined ? {} : { options: [...ask.options] }),
          blocks: ask.deadline !== null,
          asked: ask.askedAt
        }))
      ]
      if (questions.length === 0) {
        yield* provided(fs.remove(askingFile, { force: true }).pipe(Effect.orElseSucceed(() => undefined)))
        yield* provided(fs.remove(answersFile, { force: true }).pipe(Effect.orElseSucceed(() => undefined)))
        return true
      }
      const deadlines = open.flatMap((ask) => ask.deadline !== null ? [ask.deadline] : [])
      if (previous !== null && previous.questions.some(isBlockingQuestion)) {
        deadlines.push(Date.parse(previous.until))
      }
      const until = hasBlockingQuestion({ questions })
        ? new Date(deadlines.length > 0 ? Math.max(...deadlines) : Date.parse(asked)).toISOString()
        : asked
      return yield* provided(writeWhole(askingFile, JSON.stringify({ asked, until, questions })))
    })
  return {
    tick: Effect.gen(function*() {
      const shared = setup.state
      let changed = yield* registerNew()
      if (shared.asks.length === 0) {
        return
      }
      if (changed) {
        yield* writeAsking()
      }
      const asked = shared.asked
      if (asked === null) {
        return
      }
      const relayed = yield* provided(readJsonFileIfPresent(answersFile, AnswersFile).pipe(Effect.orElseSucceed(() => null)))
      const answers = relayed === null || relayed.asking !== asked ? [] : relayed.answers
      for (const ask of shared.asks) {
        const answer = answers.find((entry) => entry.question === ask.id)
        if (!ask.replied && answer !== undefined && (yield* provided(writeReply(setup, ask, { kind: "answer", id: ask.id, question: ask.question, words: answer.answer })))) {
          ask.replied = true
          changed = true
        }
      }
      const late = shared.asks.filter((ask) => !ask.replied && ask.deadline !== null && Date.now() >= ask.deadline)
      if (late.length > 0) {
        for (const ask of late) {
          if (yield* provided(writeReply(setup, ask, { kind: "timeout", id: ask.id }))) {
            ask.replied = true
            changed = true
          }
        }
        if (shared.timedOut === null) {
          shared.timedOut = late[0]
        }
      }
      if (changed) {
        yield* writeAsking()
      }
    }),
    timedOut: () => {
      const timedOut = setup.state.timedOut
      return timedOut === null ? null : { id: timedOut.id, text: timedOut.text, asked: timedOut.askedAt }
    }
  }
}
