import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { AbsolutePath, readDispatchConfig, readFailure } from "../../shared/config/index"
import { ModelRef, ProviderId } from "../../shared/config/index"
import { TaskId, backlogPaths, missingOriginWait, parseTaskFile, readAnsweredDependencies, reportKinds, parentBranch, type TaskRecord, withDecisions } from "../../entities/backlog/index"
import { latestPerId } from "../../entities/parked-runs/index"
import { TaskInstructions, readInstructions } from "./runner-instructions"
import { RunnerError } from "../../shared/process/index"
import { isRunDelivery } from "../../shared/config/index"
import { decodeTokenText, LabelArg, tokenDocumentNote, tokenFields } from "../../entities/token/index"

const taskFields = {
  task: TaskId,
  checkout: AbsolutePath,
  provider: ProviderId,
  implementerModel: Schema.optional(ModelRef),
  fixerModel: Schema.optional(ModelRef),
  body: Schema.String,
  kind: Schema.optional(Schema.Literals(reportKinds)),
  delivery: Schema.optional(Schema.Literal("direct-PR")),
  branch: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._/-]+$/))),
  resumeRun: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  machine: Schema.optional(Schema.String.check(Schema.isNonEmpty())),
  slots: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  answers: Schema.optional(Schema.Array(Schema.Struct({
    question: Schema.String.check(Schema.isPattern(/^[^\s=]+$/)),
    answer: Schema.String.check(Schema.isNonEmpty())
  }))),
  instructions: Schema.optional(TaskInstructions)
}

const QueueFileRequest = Schema.Struct({ ...taskFields, tokenFile: AbsolutePath, label: Schema.optional(LabelArg) })
export const QueueTokenRequest = Schema.Struct({ ...taskFields, ...tokenFields, label: Schema.optional(LabelArg) })
const QueueBareRequest = Schema.Struct({ ...taskFields, claudeConfigDir: Schema.optional(AbsolutePath), label: Schema.optional(LabelArg) })
export const QueueRequest = Schema.Union([QueueFileRequest, QueueTokenRequest, QueueBareRequest])
export type QueueRequest = typeof QueueRequest.Type

export const refuse = (detail: string): Effect.Effect<never, RunnerError> => Effect.fail(new RunnerError({ detail }))

const requiredEnv = (env: Readonly<Record<string, string | undefined>>, name: string): Effect.Effect<string, RunnerError> => {
  const value = env[name] ?? ""
  return value === "" ? refuse("orc runner start reads " + name + ", which the beat sets") : Effect.succeed(value)
}

const readTakenRecord = (fs: FileSystem.FileSystem, file: string): Effect.Effect<TaskRecord, RunnerError> =>
  fs.readFileString(file).pipe(
    Effect.mapError((error) => new RunnerError({ detail: "cannot read the task file " + file + ": " + readFailure(error) })),
    Effect.flatMap((text) => parseTaskFile(file, "taken", text).pipe(
      Effect.mapError((error) => new RunnerError({ detail: error.file + ": " + error.detail }))
    ))
  )

// The beat sets ORC_TASK_FILE to the task's file in the taken folder of its backlog.
const backlogOfTaken = (path: Path.Path, file: string): string => path.dirname(path.dirname(file))

const readSlots = (path: Path.Path, file: string, env: Readonly<Record<string, string | undefined>>): Effect.Effect<{ readonly slots?: number }, RunnerError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const name = env["ORC_TASK_MACHINE"] ?? ""
    if (name === "") {
      return {}
    }
    const dispatchFile = backlogPaths(backlogOfTaken(path, file)).dispatchConfig
    const config = yield* readDispatchConfig(dispatchFile).pipe(
      Effect.mapError((error) => new RunnerError({ detail: "orc runner start cannot read the slots of " + name + ": " + error.file + ": " + error.detail }))
    )
    const machine = config.machines.find((entry) => entry.name === name)
    if (machine === undefined) {
      return yield* refuse("orc runner start cannot read the slots of " + name + ": the machine is not in " + dispatchFile)
    }
    return { slots: machine.slots }
  })

const decidedBody = (path: Path.Path, file: string, record: TaskRecord): Effect.Effect<string, RunnerError, FileSystem.FileSystem> =>
  readAnsweredDependencies(backlogOfTaken(path, file), record).pipe(
    Effect.map((decisions) => withDecisions(takenBody(record), decisions)),
    Effect.mapError((error) => new RunnerError({ detail: "cannot read the decisions " + record.spec.id + " waits on: " + ("file" in error ? error.file + ": " : "") + error.detail }))
  )

const takenBody = (record: TaskRecord): string => {
  const hold = record.hold
  const decisions = hold === null ? [] : [...hold.history ?? [], hold]
  return record.spec.body + decisions.flatMap((decision) => decision.answer === null ? [] : [
    "\n\nHeld for the captain: " + decision.reason + "\nThe captain answered: " + decision.answer.words
  ]).join("")
}

const takenResume = (task: string, record: TaskRecord): Effect.Effect<Record<string, unknown>, RunnerError> => {
  if (record.parked !== null && record.parked.origin === undefined) {
    return refuse(missingOriginWait(task))
  }
  return Effect.succeed(record.parked === null
    ? (record.spec.kind === "parent" ? { branch: parentBranch(task) } : {})
    : {
      branch: record.parked.branch,
      resumeRun: record.parked.origin?.run,
      answers: latestPerId(record.parked.questions.flatMap((question) => question.answer === null ? [] : [{ ...question, answer: question.answer }])).map((question) => ({ question: question.id, answer: question.answer.words }))
    })
}

const RequestSchema = Schema.Struct(taskFields)
type RequestFields = typeof RequestSchema.Type

const handedModels = (env: Readonly<Record<string, string | undefined>>): Record<string, string> => {
  const implementer = env["ORC_TASK_IMPLEMENTER_MODEL"] ?? ""
  const fixer = env["ORC_TASK_FIXER_MODEL"] ?? ""
  return { ...(implementer === "" ? {} : { implementerModel: implementer }), ...(fixer === "" ? {} : { fixerModel: fixer }) }
}

const readRequestFields = (
  task: string,
  checkout: string,
  provider: string,
  env: Readonly<Record<string, string | undefined>>,
  record: TaskRecord,
  body: string,
  resume: Record<string, unknown>
): Effect.Effect<RequestFields, RunnerError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const deliveryWord = env["ORC_TASK_DELIVERY"] ?? "no-mistakes"
    if (!isRunDelivery(deliveryWord)) {
      return yield* refuse("orc runner start reads ORC_TASK_DELIVERY as no-mistakes or direct-PR, not " + deliveryWord)
    }
    if (record.spec.kind === "decision") {
      return yield* refuse(task + " is a decision, and a decision never runs")
    }
    const instructions = yield* readInstructions(env["ORC_TASK_INSTRUCTIONS"] ?? "")
    const kind = record.spec.kind === "ship" ? {} : { kind: record.spec.kind }
    const delivery = record.spec.kind === "ship" && deliveryWord === "direct-PR" ? { delivery: deliveryWord } : {}
    const machineName = env["ORC_RUN_MACHINE"] ?? ""
    const machine = machineName === "" ? {} : { machine: machineName }
    const models = handedModels(env)
    return yield* Schema.decodeEffect(RequestSchema)({ task, checkout, provider, body, ...models, ...kind, ...delivery, ...instructions, ...machine, ...resume }).pipe(
      Effect.mapError((error) => new RunnerError({ detail: "orc runner start cannot queue " + task + ": " + error.message }))
    )
  })

const finishFileRequest = (fields: RequestFields, task: string, tokenFile: string): Effect.Effect<QueueRequest, RunnerError> =>
  Schema.decodeEffect(QueueFileRequest)({ ...fields, tokenFile }).pipe(
    Effect.mapError((error) => new RunnerError({ detail: "orc runner start cannot queue " + task + ": " + error.message }))
  )

const finishBareRequest = (fields: RequestFields, task: string, env: Readonly<Record<string, string | undefined>>): Effect.Effect<QueueRequest, RunnerError> => {
  const claudeConfigDir = env["ORC_TASK_CLAUDE_CONFIG_DIR"]
  if (claudeConfigDir === undefined || claudeConfigDir === "") {
    return Schema.decodeEffect(QueueBareRequest)({ ...fields }).pipe(
      Effect.mapError((error) => new RunnerError({ detail: "orc runner start cannot queue " + task + ": " + error.message }))
    )
  }
  return Schema.decodeEffect(QueueBareRequest)({ ...fields, claudeConfigDir }).pipe(
    Effect.mapError((error) => new RunnerError({ detail: "orc runner start cannot queue " + task + ": " + error.message }))
  )
}

const finishTokenRequest = (fields: RequestFields, task: string, input: string): Effect.Effect<QueueRequest, RunnerError> => {
  const token = decodeTokenText(input)
  if (Option.isNone(token)) {
    return refuse("orc runner start reads ORC_TASK_TOKEN_FILE or " + tokenDocumentNote + " on stdin, one of which the beat sends")
  }
  return Effect.succeed<QueueRequest>({ ...fields, ...token.value })
}

export const readRequest = (
  env: Readonly<Record<string, string | undefined>>,
  stdin: Effect.Effect<string, RunnerError>
): Effect.Effect<QueueRequest, RunnerError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const task = yield* requiredEnv(env, "ORC_TASK_ID")
    const file = yield* requiredEnv(env, "ORC_TASK_FILE")
    const checkout = yield* requiredEnv(env, "ORC_TASK_CHECKOUT")
    const provider = yield* requiredEnv(env, "ORC_TASK_PROVIDER")
    const record = yield* readTakenRecord(fs, file)
    const body = yield* decidedBody(path, file, record)
    const resume = yield* takenResume(task, record)
    const slots = yield* readSlots(path, file, env)
    const fields = yield* readRequestFields(task, checkout, provider, env, record, body, { ...resume, ...slots })
    const tokenFile = env["ORC_TASK_TOKEN_FILE"] ?? ""
    if (tokenFile !== "") {
      return yield* finishFileRequest(fields, task, tokenFile)
    }
    const input = yield* stdin
    if (input === "") {
      return yield* finishBareRequest(fields, task, env)
    }
    return yield* finishTokenRequest(fields, task, input)
  })
