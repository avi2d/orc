import { Effect, FileSystem, Option, Schema } from "effect"
import { readJsonFileIfPresent, writeWhole } from "../../shared/config/index"
import { AnswersFile, answersFileName, AskOption, askingFileName, type OpenQuestion, type QuestionAnswer } from "../review-gate/index"
import { askFileStem, type AskReply, replySuffix } from "./orc-ask-extension"

const workerQuestionPattern = /^ask-(\d+)$/

export const isWorkerQuestion = (id: string): boolean => workerQuestionPattern.test(id)

export const longestAskWaitSeconds = 10 * 60

export const askExtensionSource = import.meta.dir + "/orc-ask-extension.ts"

export interface AskSetup {
  readonly runDir: string
  readonly askDir: string
  readonly extensionFile: string
  readonly waitSeconds: number
  readonly firstNumber: number
}

export const askSetupFor = (runDir: string, piSessionDir: string, answerWaitSeconds: number, answered: ReadonlyArray<QuestionAnswer>): AskSetup => ({
  runDir,
  askDir: piSessionDir + "/asks",
  extensionFile: piSessionDir + "/orc-ask.ts",
  waitSeconds: Math.min(answerWaitSeconds, longestAskWaitSeconds),
  firstNumber: 1 + Math.max(0, ...answered.flatMap((answer) => {
    const number = workerQuestionPattern.exec(answer.question)?.[1]
    return number === undefined ? [] : [Number(number)]
  }))
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

interface WorkerAsk {
  readonly id: string
  readonly stem: string
  readonly question: string
  readonly text: string
  readonly options: ReadonlyArray<AskOption> | undefined
  readonly deadline: number | null
  replied: boolean
}

export interface WorkerAsks {
  readonly start: (toolCallId: string, args: unknown) => Effect.Effect<string | null>
  readonly tick: Effect.Effect<void>
  readonly timedOut: () => AskedQuestion | null
  readonly finish: Effect.Effect<void>
}

const writeReply = (setup: AskSetup, ask: WorkerAsk, reply: AskReply): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  writeWhole(setup.askDir + "/" + ask.stem + replySuffix, JSON.stringify(reply))

// One asking stands for the whole Pi pass, so an answer already relayed to it still matches when a later question joins it.
export const openWorkerAsks = (fs: FileSystem.FileSystem, setup: AskSetup): WorkerAsks => {
  const asks: Array<WorkerAsk> = []
  const state: { asked: string | null; timedOut: WorkerAsk | null } = { asked: null, timedOut: null }
  const askingFile = setup.runDir + "/" + askingFileName
  const answersFile = setup.runDir + "/" + answersFileName
  const provided = <A>(effect: Effect.Effect<A, never, FileSystem.FileSystem>): Effect.Effect<A> => Effect.provideService(effect, FileSystem.FileSystem, fs)
  const writeAsking = (asked: string): Effect.Effect<boolean> => {
    const deadlines = asks.flatMap((ask) => !ask.replied && ask.deadline !== null ? [ask.deadline] : [])
    const until = new Date(deadlines.length > 0 ? Math.max(...deadlines) : Date.parse(asked) + setup.waitSeconds * 1000).toISOString()
    const questions = asks.map((ask) => ({ id: ask.id, text: ask.text, ...(ask.options === undefined ? {} : { options: ask.options }) }))
    return provided(writeWhole(askingFile, JSON.stringify({ asked, until, questions })))
  }
  return {
    start: (toolCallId, args) =>
      Option.match(decodeAskArgs(args), {
        onNone: () => Effect.succeed(null),
        onSome: (decoded) =>
          Effect.gen(function*() {
            const now = new Date().toISOString()
            const asked = state.asked ?? now
            state.asked = asked
            const ask: WorkerAsk = {
              id: "ask-" + String(setup.firstNumber + asks.length),
              stem: askFileStem(toolCallId),
              question: decoded.question.trim(),
              text: workerQuestionText(decoded),
              options: decoded.options,
              deadline: decoded.blocks ? Date.parse(now) + setup.waitSeconds * 1000 : null,
              replied: false
            }
            asks.push(ask)
            yield* writeAsking(asked)
            return ask.id
          })
      }),
    tick: Effect.gen(function*() {
      const asked = state.asked
      if (asked === null) {
        return
      }
      const relayed = yield* provided(readJsonFileIfPresent(answersFile, AnswersFile).pipe(Effect.orElseSucceed(() => null)))
      const answers = relayed === null || relayed.asking !== asked ? [] : relayed.answers
      for (const ask of asks) {
        const answer = answers.find((entry) => entry.question === ask.id)
        if (!ask.replied && answer !== undefined && (yield* provided(writeReply(setup, ask, { kind: "answer", id: ask.id, question: ask.question, words: answer.answer })))) {
          ask.replied = true
        }
      }
      const late = asks.find((ask) => !ask.replied && ask.deadline !== null && Date.now() >= ask.deadline)
      if (late !== undefined && state.timedOut === null && (yield* provided(writeReply(setup, late, { kind: "timeout", id: late.id })))) {
        late.replied = true
        state.timedOut = late
      }
    }),
    // The asking's time, not the ask's, names the item the live asking opened, so the park finds it.
    timedOut: () => state.timedOut === null || state.asked === null ? null : { id: state.timedOut.id, text: state.timedOut.text, asked: state.asked },
    finish: Effect.gen(function*() {
      if (state.asked === null) {
        return
      }
      yield* fs.remove(askingFile, { force: true }).pipe(Effect.orElseSucceed(() => undefined))
      yield* fs.remove(answersFile, { force: true }).pipe(Effect.orElseSucceed(() => undefined))
    })
  }
}
