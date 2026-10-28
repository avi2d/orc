import { Data, Effect, FileSystem, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { formatHistoryError, openDatabase, RunStatusSchema } from "../run-history"
import { latestRunForBranch } from "../history-resume"
import { claudeTokenFileVar } from "../model-route"
import type { Reach } from "./args"
import { TaskId } from "./backlog"
import { heldTask, orcGroup, PueueResult, PueueState, PueueStatus, type PueueTask } from "./pueue-status"
import { parseTaskFile } from "./task-record"

const RUNNER_JSON_SCHEMA = "orc.runner.v1" as const

export class RunnerError extends Data.TaggedError("RunnerError")<{
  readonly detail: string
}> {}

export type Command = readonly [string, ...Array<string>]

const AbsolutePath = Schema.String.check(Schema.isPattern(/^\//))

const QueueRequest = Schema.Struct({
  task: TaskId,
  checkout: AbsolutePath,
  tokenFile: AbsolutePath,
  body: Schema.String
})
type QueueRequest = typeof QueueRequest.Type

const RunSummary = Schema.Struct({
  id: Schema.String,
  status: RunStatusSchema,
  prLink: Schema.NullOr(Schema.String),
  endReason: Schema.NullOr(Schema.String)
})
type RunSummary = typeof RunSummary.Type

const heldFields = {
  task: TaskId,
  pueueTask: Schema.Int,
  run: Schema.NullOr(RunSummary)
}

const RunnerResult = Schema.Union([
  Schema.Struct({ task: TaskId, status: Schema.Literal("unknown") }),
  Schema.Struct({ ...heldFields, status: Schema.Literals(["queued", "stashed"]) }),
  Schema.Struct({ ...heldFields, status: Schema.Literals(["running", "paused"]), started: Schema.String }),
  Schema.Struct({ ...heldFields, status: Schema.Literal("succeeded"), started: Schema.String, ended: Schema.String }),
  Schema.Struct({ ...heldFields, status: Schema.Literal("failed"), started: Schema.String, ended: Schema.String, reason: Schema.String })
])
export type RunnerResult = typeof RunnerResult.Type

const RunnerDocument = Schema.Struct({ schema: Schema.Literal(RUNNER_JSON_SCHEMA), result: RunnerResult })

type RunnerRequirements = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner

const taskBranch = (task: string): string => "orc/" + task

const refuse = (detail: string) => Effect.fail(new RunnerError({ detail }))

interface Captured {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

const capture = (command: Command, stdin: string | null, env?: Record<string, string>): Effect.Effect<Captured, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const [program, ...args] = command
    const handle = yield* spawner.spawn(ChildProcess.make(program, args, env === undefined
      ? {
        stdin: stdin === null ? "ignore" : Stream.fromIterable([new TextEncoder().encode(stdin)])
      }
      : {
        stdin: stdin === null ? "ignore" : Stream.fromIterable([new TextEncoder().encode(stdin)]),
        env,
        extendEnv: true
      }))
    const [stdout, stderr, exitCode] = yield* Effect.all([
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      handle.exitCode
    ], { concurrency: "unbounded" })
    return { exitCode, stdout, stderr }
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) => new RunnerError({ detail: command[0] + " did not run: " + error.message }))
  )

const pueue = (args: ReadonlyArray<string>, env?: Record<string, string>): Effect.Effect<string, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  capture(["pueue", ...args], null, env).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result.stdout)
        : refuse("pueue " + (args[0] ?? "") + " exited " + result.exitCode + ": " + result.stderr.trim())
    )
  )

const decodeJson = <S extends Schema.Top & { readonly DecodingServices: never }>(
  text: string,
  schema: S,
  what: string
): Effect.Effect<S["Type"], RunnerError> =>
  Effect.try({ try: (): unknown => JSON.parse(text), catch: () => new RunnerError({ detail: what + " printed no JSON" }) }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError((error) => error instanceof RunnerError ? error : new RunnerError({ detail: what + " printed JSON orc cannot read: " + error.message }))
  )

const readHeld = (task: string): Effect.Effect<PueueTask | null, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  pueue(["status", "--json"]).pipe(
    Effect.flatMap((text) => decodeJson(text, PueueState, "pueue status --json")),
    Effect.map((state) => heldTask(state.tasks, task))
  )

const PueueGroups = Schema.Record(Schema.String, Schema.Unknown)

const readOrcGroup = (): Effect.Effect<boolean, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  pueue(["group", "--json"]).pipe(
    Effect.flatMap((text) => decodeJson(text, PueueGroups, "pueue group --json")),
    Effect.map((groups) => Object.hasOwn(groups, orcGroup))
  )

const ensureOrcGroup = (): Effect.Effect<void, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  readOrcGroup().pipe(
    Effect.flatMap((present) =>
      present
        ? Effect.void
        : pueue(["group", "add", orcGroup]).pipe(
          Effect.asVoid,
          Effect.catch((error) =>
            readOrcGroup().pipe(
              Effect.flatMap((now) => now ? Effect.void : Effect.fail(error))
            )
          )
        )
    )
  )

const resolveProjectDir = (checkout: string): Effect.Effect<string, never, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const fs = yield* FileSystem.FileSystem
    const top = yield* Effect.scoped(
      Effect.gen(function*() {
        const handle = yield* spawner.spawn(ChildProcess.make("git", ["rev-parse", "--show-toplevel"], { cwd: checkout }))
        const [stdout, exitCode] = yield* Effect.all([
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.exitCode
        ], { concurrency: "unbounded" })
        return { stdout, exitCode }
      })
    ).pipe(Effect.orElseSucceed(() => null))
    if (top === null || top.exitCode !== 0 || top.stdout.trim() === "") {
      return checkout
    }
    return yield* fs.realPath(top.stdout.trim()).pipe(Effect.orElseSucceed(() => top.stdout.trim()))
  })

const requireFolder = (checkout: string): Effect.Effect<void, RunnerError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const info = yield* fs.stat(checkout).pipe(Effect.orElseSucceed(() => null))
    if (info?.type !== "Directory") {
      return yield* refuse("the checkout " + checkout + " is no folder on this machine")
    }
  })

// The beat starts each task once, so this check keeps a rerun start from queueing a second run, not two starts racing.
const queueTask = (
  request: QueueRequest,
  self: Command,
  home: string
): Effect.Effect<string, RunnerError, RunnerRequirements> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* requireFolder(request.checkout)
    const project = yield* resolveProjectDir(request.checkout)
    yield* ensureOrcGroup()
    const held = yield* readHeld(request.task)
    if (held !== null) {
      return request.task + " is already pueue task " + held.id + " in group " + orcGroup
    }
    const folder = home + "/runner"
    const taskFile = folder + "/" + request.task + ".md"
    yield* fs.makeDirectory(folder, { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(taskFile, request.body)),
      Effect.mapError((error) => new RunnerError({ detail: "cannot write " + taskFile + ": " + error.message }))
    )
    const id = yield* pueue([
      "add", "--group", orcGroup, "--label", request.task, "--working-directory", project, "--print-task-id", "--escape", "--",
      ...self, "run", taskFile, "--branch", taskBranch(request.task), "--sandbox", "none"
    ], { ORC_HOME: home, [claudeTokenFileVar]: request.tokenFile })
    return "queued " + request.task + " as pueue task " + id.trim() + " in group " + orcGroup
  })

export const queueFromText = (text: string, self: Command, home: string): Effect.Effect<string, RunnerError, RunnerRequirements> =>
  decodeJson(text, QueueRequest, "the queue request on stdin").pipe(Effect.flatMap((request) => queueTask(request, self, home)))

const requiredEnv = (env: Readonly<Record<string, string | undefined>>, name: string): Effect.Effect<string, RunnerError> => {
  const value = env[name] ?? ""
  return value === "" ? refuse("orc runner start reads " + name + ", which the beat sets") : Effect.succeed(value)
}

const readRequest = (env: Readonly<Record<string, string | undefined>>): Effect.Effect<QueueRequest, RunnerError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const task = yield* requiredEnv(env, "ORC_TASK_ID")
    const file = yield* requiredEnv(env, "ORC_TASK_FILE")
    const checkout = yield* requiredEnv(env, "ORC_TASK_CHECKOUT")
    const tokenFile = yield* requiredEnv(env, "ORC_TASK_TOKEN_FILE")
    const text = yield* fs.readFileString(file).pipe(
      Effect.mapError((error) => new RunnerError({ detail: "cannot read the task file " + file + ": " + error.message }))
    )
    const record = yield* parseTaskFile(file, "taken", text).pipe(
      Effect.mapError((error) => new RunnerError({ detail: error.file + ": " + error.detail }))
    )
    return yield* Schema.decodeEffect(QueueRequest)({ task, checkout, tokenFile, body: record.spec.body }).pipe(
      Effect.mapError((error) => new RunnerError({ detail: "orc runner start cannot queue " + task + ": " + error.message }))
    )
  })

const handThrough = (command: Command, request: QueueRequest): Effect.Effect<void, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const [program, ...args] = command
    const handle = yield* spawner.spawn(ChildProcess.make(program, [...args, "runner", "queue"], {
      stdin: Stream.fromIterable([new TextEncoder().encode(JSON.stringify(request))]),
      stdout: "inherit",
      stderr: "inherit"
    }))
    const exitCode = yield* handle.exitCode
    if (exitCode !== 0) {
      return yield* refuse(command.join(" ") + " runner queue exited " + exitCode)
    }
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) => error instanceof RunnerError ? error : new RunnerError({ detail: command[0] + " did not run: " + error.message }))
  )

export const startTask = (
  env: Readonly<Record<string, string | undefined>>,
  reach: Reach,
  self: Command,
  home: string
): Effect.Effect<string | null, RunnerError, RunnerRequirements> =>
  Effect.gen(function*() {
    const request = yield* readRequest(env)
    if (reach.kind === "here") {
      return yield* queueTask(request, self, home)
    }
    yield* handThrough(reach.command, request)
    return null
  })

const failureReason = (result: typeof PueueResult.Type): string | null => {
  if (result === "Success") {
    return null
  }
  if (typeof result === "object") {
    return "Failed" in result ? "orc exited " + result.Failed : "pueue could not start it: " + result.FailedToSpawn
  }
  switch (result) {
    case "Killed": {
      return "the run was killed"
    }
    case "Errored": {
      return "pueue lost the run to an error"
    }
    case "DependencyFailed": {
      return "a task it waited on failed"
    }
  }
}

const assessHeld = (
  task: string,
  pueueTask: number,
  status: PueueStatus,
  run: RunSummary | null
): RunnerResult => {
  const held = { task, pueueTask, run }
  if ("Done" in status) {
    const { start, end, result } = status.Done
    const reason = failureReason(result)
    return reason === null
      ? { ...held, status: "succeeded", started: start, ended: end }
      : { ...held, status: "failed", started: start, ended: end, reason }
  }
  if ("Running" in status) {
    return { ...held, status: "running", started: status.Running.start }
  }
  if ("Paused" in status) {
    return { ...held, status: "paused", started: status.Paused.start }
  }
  return { ...held, status: "Stashed" in status ? "stashed" : "queued" }
}

const readRun = (home: string, checkout: string, task: string): Effect.Effect<RunSummary | null, RunnerError, RunnerRequirements> =>
  Effect.gen(function*() {
    const project = yield* resolveProjectDir(checkout)
    const run = yield* Effect.acquireUseRelease(
      openDatabase(home),
      (db) => latestRunForBranch(db, project, taskBranch(task)),
      (db) => Effect.sync(() => db.close())
    )
    return run === null ? null : { id: run.id, status: run.status, prLink: run.prLink, endReason: run.endReason }
  }).pipe(
    Effect.mapError((error) => error instanceof RunnerError ? error : new RunnerError({ detail: "cannot read the run history: " + formatHistoryError(error) }))
  )

export const readResult = (task: string, home: string): Effect.Effect<RunnerResult, RunnerError, RunnerRequirements> =>
  Effect.gen(function*() {
    const held = yield* readHeld(task)
    if (held === null) {
      return { task, status: "unknown" } satisfies RunnerResult
    }
    const status = yield* Schema.decodeUnknownEffect(PueueStatus)(held.status).pipe(
      Effect.mapError((error) => new RunnerError({ detail: "pueue reports a status orc cannot read for task " + held.id + ": " + error.message }))
    )
    const run = yield* readRun(home, held.path, task)
    return assessHeld(task, held.id, status, run)
  })

export const readResultThrough = (command: Command, task: string): Effect.Effect<RunnerResult, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  capture([...command, "runner", "result", task, "--json"], null).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? decodeJson(result.stdout, RunnerDocument, command.join(" ") + " runner result")
        : refuse(command.join(" ") + " runner result exited " + result.exitCode + ": " + result.stderr.trim())
    ),
    Effect.map((document) => document.result)
  )

export const runnerJson = (result: RunnerResult): typeof RunnerDocument.Type => ({ schema: RUNNER_JSON_SCHEMA, result })

const headLine = (result: RunnerResult): string => {
  switch (result.status) {
    case "unknown": {
      return result.task + ": no pueue task in group " + orcGroup + " holds it"
    }
    case "queued":
    case "stashed": {
      return result.task + ": " + result.status + " as pueue task " + result.pueueTask
    }
    case "running":
    case "paused": {
      return result.task + ": " + result.status + " as pueue task " + result.pueueTask + " since " + result.started
    }
    case "succeeded": {
      return result.task + ": succeeded as pueue task " + result.pueueTask + ", " + result.started + " to " + result.ended
    }
    case "failed": {
      return result.task + ": failed as pueue task " + result.pueueTask + ", " + result.started + " to " + result.ended + ": " + result.reason
    }
  }
}

const runLine = (task: string, run: RunSummary | null): string =>
  run === null
    ? "orc holds no run on " + taskBranch(task)
    : "orc run " + run.id + " " + run.status + (run.prLink === null ? "" : ", PR " + run.prLink) + (run.endReason === null ? "" : ": " + run.endReason)

export const formatResult = (result: RunnerResult): string => {
  if (result.status === "unknown") {
    return headLine(result)
  }
  return [headLine(result), runLine(result.task, result.run)].join("\n")
}
