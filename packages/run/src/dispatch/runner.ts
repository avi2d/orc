import { Data, DateTime, Duration, Effect, FileSystem, Option, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { Reach } from "./args"
import { AbsolutePath } from "../json-file"
import { ProviderId } from "../orc-config"
import { TaskId } from "./backlog"
import { dropHeldToken, heldTokenFile, holdToken, releaseHeldToken, replaceHeldToken } from "./held-token"
import { heldTask, orcGroup, PueueState, PueueStatus, taskLabel, type PueueTask } from "./pueue-status"
import { parseTaskFile } from "./task-record"
import { decodeTokenText, encodeRenewal, encodeSecretJson, LabelArg, RenewRequest, type TokenEncodeError, tokenDocumentNote, tokenFields } from "./token"

export class RunnerError extends Data.TaggedError("RunnerError")<{
  readonly detail: string
}> {}

export type Command = readonly [string, ...Array<string>]

const taskFields = {
  task: TaskId,
  checkout: AbsolutePath,
  provider: ProviderId,
  body: Schema.String
}

const QueueRequest = Schema.Union([
  Schema.Struct({ ...taskFields, tokenFile: AbsolutePath, label: Schema.optional(LabelArg) }),
  Schema.Struct({ ...taskFields, ...tokenFields, label: Schema.optional(LabelArg) })
])
type QueueRequest = typeof QueueRequest.Type

export type RunnerRequirements = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner

export const taskBranch = (task: string): string => "orc/" + task

export const refuse = (detail: string): Effect.Effect<never, RunnerError> => Effect.fail(new RunnerError({ detail }))

interface Captured {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export const capture = (command: Command, stdin: string | null, env?: Record<string, string>): Effect.Effect<Captured, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
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

export const decodeJson = <S extends Schema.Top & { readonly DecodingServices: never }>(
  text: string,
  schema: S,
  what: string
): Effect.Effect<S["Type"], RunnerError> =>
  Effect.try({ try: (): unknown => JSON.parse(text), catch: () => new RunnerError({ detail: what + " printed no JSON" }) }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError((error) => error instanceof RunnerError ? error : new RunnerError({ detail: what + " printed JSON orc cannot read: " + error.message }))
  )

// A decode failure carries the text it read, which may hold the token, so the refusal names only the shape it wanted.
const decodeSecret = <S extends Schema.Top & { readonly DecodingServices: never }>(
  text: string,
  schema: S,
  refusal: string
): Effect.Effect<S["Type"], RunnerError> =>
  Effect.try({ try: (): unknown => JSON.parse(text), catch: () => new RunnerError({ detail: refusal }) }).pipe(
    Effect.flatMap((json) => Schema.decodeUnknownEffect(schema)(json, { onExcessProperty: "error" })),
    Effect.mapError(() => new RunnerError({ detail: refusal }))
  )

const queueRefusal = "the queue request on stdin is no task, checkout, provider and body with either a tokenFile or a token and an expiresAt"

const renewRefusal = "the renew request on stdin is no task with a token and an expiresAt"

const encodeRefusal = (error: TokenEncodeError): RunnerError => new RunnerError({ detail: "the " + error.what + " would not encode" })

const encodeQueueRequest = (request: QueueRequest): Effect.Effect<string, RunnerError> =>
  encodeSecretJson(QueueRequest, "queue request")(request).pipe(Effect.mapError(encodeRefusal))

export const readHeld = (home: string, task: string, label?: string | null): Effect.Effect<PueueTask | null, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  pueue(["status", "--json"]).pipe(
    Effect.flatMap((text) => decodeJson(text, PueueState, "pueue status --json")),
    Effect.map((state) => heldTask(state.tasks, home, task, label))
  )

export const labelOf = (home: string, task: string, label?: string | null): string => label ?? taskLabel(home, task)

export const fileKeyOf = (home: string, task: string, label: string): string => label === taskLabel(home, task) ? task : "label-" + encodeURIComponent(label)

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

export const resolveProjectDir = (checkout: string): Effect.Effect<string, never, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
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

const queuedGuardScript = "pueue wait \"$1\" && rm -rf -- \"$2\""

const guardQueued = (home: string, id: string, dir: string): Effect.Effect<void, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make("sh", ["-c", queuedGuardScript, "orc-token-guard", id, dir], {
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { ORC_HOME: home },
      extendEnv: true
    }))
    yield* Effect.asVoid(handle.unref)
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) => new RunnerError({ detail: "the token guard did not start: " + error.message }))
  )

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
    const label = labelOf(home, request.task, request.label)
    const key = fileKeyOf(home, request.task, label)
    const held = yield* readHeld(home, request.task, label)
    if (held !== null) {
      return request.task + " is already pueue task " + held.id + " in group " + orcGroup
    }
    const folder = home + "/runner"
    const taskFile = folder + "/" + key + ".md"
    yield* fs.makeDirectory(folder, { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(taskFile, request.body)),
      Effect.mapError((error) => new RunnerError({ detail: "cannot write " + taskFile + ": " + error.message }))
    )
    const run = [...self, "run", taskFile, "--branch", taskBranch(request.task), "--sandbox", "none", "--provider", request.provider]
    const add = (command: ReadonlyArray<string>) =>
      pueue(["add", "--group", orcGroup, "--label", label, "--working-directory", project, "--print-task-id", "--escape", "--", ...command], { ORC_HOME: home })
    const holdArgs: ReadonlyArray<string> = label === taskLabel(home, request.task) ? [request.task] : [request.task, "--label", label]
    if ("tokenFile" in request) {
      const id = yield* add([...run, "--token-file", request.tokenFile])
      return "queued " + request.task + " as pueue task " + id.trim() + " in group " + orcGroup
    }
    const dir = yield* holdToken(home, key, request).pipe(
      Effect.mapError((error) => new RunnerError({ detail: "cannot hold the token for " + request.task + ": " + error.message })),
      Effect.tapError(() => releaseHeldToken(home, key))
    )
    const id = yield* add([...self, "runner", "hold", ...holdArgs, "--", ...run, "--token-file", heldTokenFile(dir)]).pipe(
      Effect.tapError(() => releaseHeldToken(home, key))
    )
    yield* guardQueued(home, id.trim(), dir).pipe(Effect.tapError(() => releaseHeldToken(home, key)))
    return "queued " + request.task + " as pueue task " + id.trim() + " in group " + orcGroup
  })

export const queueFromText = (text: string, self: Command, home: string): Effect.Effect<string, RunnerError, RunnerRequirements> =>
  decodeSecret(text, QueueRequest, queueRefusal).pipe(Effect.flatMap((request) => queueTask(request, self, home)))

const pueueDone = (task: PueueTask): boolean =>
  Option.exists(Schema.decodeUnknownOption(PueueStatus)(task.status), (status) => "Done" in status)

const renewHere = (request: RenewRequest, home: string): Effect.Effect<string, RunnerError, RunnerRequirements> =>
  Effect.gen(function*() {
    const label = labelOf(home, request.task, request.label)
    const key = fileKeyOf(home, request.task, label)
    const held = yield* readHeld(home, request.task, label)
    const fail = (error: { readonly message: string }) => new RunnerError({ detail: "cannot renew the token for " + request.task + ": " + error.message })
    if (held === null || pueueDone(held)) {
      yield* dropHeldToken(home, key).pipe(Effect.mapError(fail))
      return yield* refuse(request.task + " has no queued or running pueue task here, so no token is kept for it")
    }
    if (!(yield* replaceHeldToken(home, key, request).pipe(Effect.mapError(fail)))) {
      return yield* refuse(request.task + " holds no token here, so the renewal is dropped")
    }
    return "renewed the token for " + request.task + " until " + DateTime.formatIso(request.expiresAt)
  })

const requiredEnv = (env: Readonly<Record<string, string | undefined>>, name: string): Effect.Effect<string, RunnerError> => {
  const value = env[name] ?? ""
  return value === "" ? refuse("orc runner start reads " + name + ", which the beat sets") : Effect.succeed(value)
}

const readRequest = (
  env: Readonly<Record<string, string | undefined>>,
  stdin: Effect.Effect<string, RunnerError>
): Effect.Effect<QueueRequest, RunnerError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const task = yield* requiredEnv(env, "ORC_TASK_ID")
    const file = yield* requiredEnv(env, "ORC_TASK_FILE")
    const checkout = yield* requiredEnv(env, "ORC_TASK_CHECKOUT")
    const provider = yield* requiredEnv(env, "ORC_TASK_PROVIDER")
    const text = yield* fs.readFileString(file).pipe(
      Effect.mapError((error) => new RunnerError({ detail: "cannot read the task file " + file + ": " + error.message }))
    )
    const record = yield* parseTaskFile(file, "taken", text).pipe(
      Effect.mapError((error) => new RunnerError({ detail: error.file + ": " + error.detail }))
    )
    const fields = yield* Schema.decodeEffect(Schema.Struct(taskFields))({ task, checkout, provider, body: record.spec.body }).pipe(
      Effect.mapError((error) => new RunnerError({ detail: "orc runner start cannot queue " + task + ": " + error.message }))
    )
    const tokenFile = env["ORC_TASK_TOKEN_FILE"] ?? ""
    if (tokenFile !== "") {
      return yield* Schema.decodeEffect(QueueRequest)({ ...fields, tokenFile }).pipe(
        Effect.mapError((error) => new RunnerError({ detail: "orc runner start cannot queue " + task + ": " + error.message }))
      )
    }
    const token = decodeTokenText(yield* stdin)
    if (Option.isNone(token)) {
      return yield* refuse("orc runner start reads ORC_TASK_TOKEN_FILE or " + tokenDocumentNote + " on stdin, one of which the beat sends")
    }
    return { ...fields, ...token.value }
  })

const forwardSeconds = 30

const handThrough = (command: Command, verb: "queue" | "renew", input: string): Effect.Effect<void, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const [program, ...args] = command
    const handle = yield* spawner.spawn(ChildProcess.make(program, [...args, "runner", verb], {
      stdin: Stream.fromIterable([new TextEncoder().encode(input)]),
      stdout: "inherit",
      stderr: "inherit"
    }))
    const exitCode = yield* handle.exitCode
    if (exitCode !== 0) {
      return yield* refuse(command.join(" ") + " runner " + verb + " exited " + exitCode)
    }
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: Duration.seconds(forwardSeconds),
      orElse: () => Effect.fail(new RunnerError({ detail: command.join(" ") + " runner " + verb + " timed out" }))
    }),
    Effect.mapError((error) => error instanceof RunnerError ? error : new RunnerError({ detail: command[0] + " did not run: " + error.message }))
  )

export const startTask = (
  env: Readonly<Record<string, string | undefined>>,
  stdin: Effect.Effect<string, RunnerError>,
  reach: Reach,
  self: Command,
  home: string
): Effect.Effect<string | null, RunnerError, RunnerRequirements> =>
  Effect.gen(function*() {
    const request = yield* readRequest(env, stdin)
    if (reach.kind === "here") {
      return yield* queueTask(request, self, home)
    }
    const label = taskLabel(home, request.task)
    yield* handThrough(reach.command, "queue", yield* encodeQueueRequest({ ...request, label }))
    return null
  })

export const renewTask = (
  stdin: Effect.Effect<string, RunnerError>,
  reach: Reach,
  home: string
): Effect.Effect<string | null, RunnerError, RunnerRequirements> =>
  Effect.gen(function*() {
    const request = yield* decodeSecret(yield* stdin, RenewRequest, renewRefusal)
    if (reach.kind === "here") {
      return yield* renewHere(request, home)
    }
    const label = request.label ?? taskLabel(home, request.task)
    yield* handThrough(reach.command, "renew", yield* encodeRenewal({ ...request, label }).pipe(Effect.mapError(encodeRefusal)))
    return null
  })
