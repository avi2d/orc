import { Effect, FileSystem, Option, Schema } from "effect"
import { readJsonFileIfPresent, writeWhole } from "../../shared/config/index"
import { AnswersFile, answersFileName, Asking, AskOption, askingFileName, hasBlockingQuestion, type OpenQuestion, type QuestionAnswer } from "../review-gate/index"
import { askFileStem, type AskReply, replySuffix } from "./orc-ask-extension"

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
}

export interface AskSetup {
  readonly runDir: string
  readonly askDir: string
  readonly extensionFile: string
  readonly waitSeconds: number
  readonly state: AskRunState
}

export const askSetupFor = (runDir: string, piSessionDir: string, answerWaitSeconds: number, answered: ReadonlyArray<QuestionAnswer>): AskSetup => ({
  runDir,
  askDir: piSessionDir + "/asks",
  extensionFile: piSessionDir + "/orc-ask.ts",
  waitSeconds: Math.min(answerWaitSeconds, longestAskWaitSeconds),
  state: {
    next: 1 + Math.max(0, ...answered.flatMap((answer) => {
      const number = workerQuestionPattern.exec(answer.question)?.[1]
      return number === undefined ? [] : [Number(number)]
    })),
    asked: null,
    timedOut: null,
    asks: []
  }
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

export interface WorkerAsks {
  readonly start: (toolCallId: string, args: unknown) => Effect.Effect<string | null>
  readonly tick: Effect.Effect<void>
  readonly timedOut: () => AskedQuestion | null
  readonly finish: Effect.Effect<void>
}

const writeReply = (setup: AskSetup, ask: WorkerAsk, reply: AskReply): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  writeWhole(setup.askDir + "/" + ask.stem + replySuffix, JSON.stringify(reply))

export const openWorkerAsks = (fs: FileSystem.FileSystem, setup: AskSetup): WorkerAsks => {
  const askingFile = setup.runDir + "/" + askingFileName
  const answersFile = setup.runDir + "/" + answersFileName
  const provided = <A>(effect: Effect.Effect<A, never, FileSystem.FileSystem>): Effect.Effect<A> => Effect.provideService(effect, FileSystem.FileSystem, fs)
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
      const deadlines = open.flatMap((ask) => ask.deadline !== null ? [ask.deadline] : [])
      if (previous !== null && previous.questions.some((question) => question.blocks !== false)) {
        deadlines.push(Date.parse(previous.until))
      }
      const blocking = questions.some((question) => question.blocks !== false)
      const until = blocking
        ? new Date(deadlines.length > 0 ? Math.max(...deadlines) : Date.parse(asked)).toISOString()
        : asked
      return yield* provided(writeWhole(askingFile, JSON.stringify({ asked, until, questions })))
    })
  return {
    start: (toolCallId, args) =>
      Option.match(decodeAskArgs(args), {
        onNone: () => Effect.succeed(null),
        onSome: (decoded) =>
          Effect.gen(function*() {
            const shared = setup.state
            const now = new Date().toISOString()
            if (shared.asked === null) {
              const previous = yield* provided(readJsonFileIfPresent(askingFile, Asking).pipe(Effect.orElseSucceed(() => null)))
              shared.asked = previous?.asked ?? now
            }
            const ask: WorkerAsk = {
              id: "ask-" + String(shared.next),
              stem: askFileStem(toolCallId),
              question: decoded.question.trim(),
              text: workerQuestionText(decoded),
              options: decoded.options,
              deadline: decoded.blocks ? Date.parse(now) + setup.waitSeconds * 1000 : null,
              askedAt: now,
              replied: false
            }
            shared.next += 1
            shared.asks.push(ask)
            yield* writeAsking()
            return ask.id
          })
      }),
    tick: Effect.gen(function*() {
      const shared = setup.state
      const asked = shared.asked
      if (asked === null) {
        return
      }
      const relayed = yield* provided(readJsonFileIfPresent(answersFile, AnswersFile).pipe(Effect.orElseSucceed(() => null)))
      const answers = relayed === null || relayed.asking !== asked ? [] : relayed.answers
      let changed = false
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
    timedOut: () => sharedOf(setup).timedOut === null || sharedOf(setup).asked === null ? null : { id: sharedOf(setup).timedOut!.id, text: sharedOf(setup).timedOut!.text, asked: sharedOf(setup).timedOut!.askedAt },
    finish: Effect.void
  }
}

const sharedOf = (setup: AskSetup): AskRunState => setup.state
