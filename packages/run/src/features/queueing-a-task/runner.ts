import { DateTime, Duration, Effect, FileSystem, Option, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { decodeJson, decodeSecret, ensureGroup, pueue, type Command, type Reach } from "../../shared/process/index"
import { readOrcConfig } from "../../shared/config/index"
import { fileKeyOf, labelOf, parentBranch, runLabel, taskBranch } from "../../entities/backlog/index"
import { dropHeldToken, heldTokenFile, holdToken, releaseHeldToken, replaceHeldToken } from "../../entities/token/index"
import { heldTask, orcGroup, parentLabel, PueueState, PueueStatus, taskLabel, type PueueTask } from "../../shared/process/index"
import { writeInstructions } from "./runner-instructions"
import { RunnerError } from "../../shared/process/index"
import { resumePriorRun, runsForBranch } from "../../entities/run-history/index"
import { formatHistoryError, markRunStopped, openDatabase, recordRun, stoppedEndReason } from "../../entities/run-history/index"
import { QueueRequest, QueueTokenRequest, readRequest, refuse } from "./runner-request"

export { refuse }

type QueueToken = typeof QueueTokenRequest.Type

import { newRunId } from "../../shared/lib/index"
import { encodeRenewal, encodeSecretJson, RenewRequest, type TokenEncodeError } from "../../entities/token/index"

export type RunnerRequirements = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner

const queueRefusal = "the queue request on stdin is no task, checkout, provider and body with an optional tokenFile or an optional token and expiresAt"

const renewRefusal = "the renew request on stdin is no task with a token and an expiresAt"

const encodeRefusal = (error: TokenEncodeError): RunnerError => new RunnerError({ detail: "the " + error.what + " would not encode" })

const encodeQueueRequest = (request: QueueRequest): Effect.Effect<string, RunnerError> =>
  encodeSecretJson(QueueRequest, "queue request")(request).pipe(Effect.mapError(encodeRefusal))

export const readHeld = (home: string, task: string, label?: string | null): Effect.Effect<PueueTask | null, RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  pueue(["status", "--json"]).pipe(
    Effect.flatMap((text) => decodeJson(text, PueueState, "pueue status --json")),
    Effect.map((state) => heldTask(state.tasks, home, task, label))
  )

const markTaskRunsStopped = (home: string, project: string, task: string, taskFile: string, started: string, stoppedBranch: string): Effect.Effect<void, RunnerError, RunnerRequirements> =>
  Effect.gen(function*() {
    const ended = DateTime.formatIso(yield* DateTime.now)
    yield* Effect.acquireUseRelease(
      openDatabase(home),
      (db) =>
        Effect.gen(function*() {
          const branches = [taskBranch(task), parentBranch(task)]
          const grouped = yield* Effect.forEach(branches, (branch) => runsForBranch(db, project, branch))
          const running = grouped.flat().filter((run) => run.status === "running")
          if (running.length === 0) {
            yield* recordRun(db, { id: newRunId(), project, branch: stoppedBranch, taskFile, status: "stopped", started, ended, endReason: stoppedEndReason })
            return
          }
          yield* Effect.forEach(running, (run) => markRunStopped(db, run.id, ended, stoppedEndReason), { discard: true })
        }),
      (db) => Effect.sync(() => db.close())
    )
  }).pipe(
    Effect.mapError((error) => error instanceof RunnerError ? error : new RunnerError({ detail: "cannot mark the run stopped: " + formatHistoryError(error) }))
  )

export const killHeld = (
  home: string,
  task: string,
  label?: string | null
): Effect.Effect<string, RunnerError, RunnerRequirements> =>
  Effect.gen(function*() {
    const held = yield* readHeld(home, task, label)
    if (held === null) {
      return yield* refuse(task + " has no pueue task in group " + orcGroup + ", so nothing stops it")
    }
    if (pueueDone(held)) {
      return yield* refuse(task + " already finished as pueue task " + held.id + ", so nothing stops it")
    }
    const killed = yield* pueue(["kill", String(held.id)]).pipe(
      Effect.as(true),
      Effect.catchTag("RunnerError", () => Effect.succeed(false))
    )
    const taskFile = home + "/runner/" + fileKeyOf(home, task, labelOf(home, task, label)) + ".md"
    const stoppedBranch = labelOf(home, task, label) === parentLabel(home, task) ? parentBranch(task) : taskBranch(task)
    const started = Option.match(Schema.decodeUnknownOption(PueueStatus)(held.status), {
      onNone: () => null,
      onSome: (status) => "Running" in status ? status.Running.start : "Paused" in status ? status.Paused.start : null
    }) ?? DateTime.formatIso(yield* DateTime.now)
    if (killed) {
      yield* markTaskRunsStopped(home, held.path, task, taskFile, started, stoppedBranch)
      return "killed pueue task " + held.id + " for " + task
    }
    yield* pueue(["remove", String(held.id)])
    yield* markTaskRunsStopped(home, held.path, task, taskFile, started, stoppedBranch)
    return "removed pueue task " + held.id + " for " + task
  })

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

const checkQueueConfig = (home: string, request: QueueRequest): Effect.Effect<void, RunnerError, FileSystem.FileSystem> =>
  readOrcConfig(home).pipe(
    Effect.mapError((error) => new RunnerError({ detail: error.file + ": " + error.detail })),
    Effect.flatMap((config) =>
      "claudeConfigDir" in request && request.claudeConfigDir !== undefined && config.providers.find((provider) => provider.id === request.provider)?.credential !== "package"
        ? refuse("the Claude config directory requires a package provider named " + request.provider)
        : Effect.void
    )
  )

const bareCommand = (run: ReadonlyArray<string>, claudeConfigDir: string | undefined): ReadonlyArray<string> =>
  claudeConfigDir === undefined ? run : ["env", "ORC_DISPATCH_CLAUDE_CONFIG_DIR=" + claudeConfigDir, ...run]

const requireResumeRun = (home: string, project: string, branch: string, expected: string | undefined) =>
  expected === undefined ? Effect.void : Effect.acquireUseRelease(
    openDatabase(home),
    (db) => resumePriorRun(db, project, branch).pipe(Effect.flatMap((prior) =>
      prior?.id === expected ? Effect.void : refuse("cannot resume " + expected + " on " + branch + ": " + (prior === null ? "no previous run is available" : "the latest resumable run is " + prior.id))
    )),
    (db) => Effect.sync(() => db.close())
  ).pipe(Effect.mapError((error) => error instanceof RunnerError ? error : new RunnerError({ detail: "cannot check parked run " + expected + ": " + formatHistoryError(error) })))

const writeTaskFile = (home: string, key: string, body: string): Effect.Effect<string, RunnerError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const folder = home + "/runner"
    const taskFile = folder + "/" + key + ".md"
    yield* fs.makeDirectory(folder, { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(taskFile, body)),
      Effect.mapError((error) => new RunnerError({ detail: "cannot write " + taskFile + ": " + error.message })))
    return taskFile
  })

const withClaimedMachine = (machine: string | undefined): ReadonlyArray<string> =>
  machine === undefined ? [] : ["ORC_RUN_MACHINE=" + machine]

const buildRun = (
  request: QueueRequest,
  self: Command,
  home: string,
  key: string,
  taskFile: string
): Effect.Effect<ReadonlyArray<string>, RunnerError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const folder = home + "/runner"
    const answers = (request.answers ?? []).flatMap((entry) => ["--answer", entry.question + "=" + entry.answer])
    const kind = request.kind === undefined ? [] : ["--kind", request.kind]
    const delivery = request.delivery === undefined ? [] : ["--delivery", request.delivery]
    const instructions = request.instructions === undefined ? [] : ["--instructions", yield* writeInstructions(folder + "/" + key + ".instructions", request.instructions)]
    const resume = request.resumeRun === undefined ? [] : ["ORC_DISPATCH_RESUME_RUN=" + request.resumeRun]
    const assigned = [...resume, ...withClaimedMachine(request.machine)]
    const env = assigned.length === 0 ? [] : ["env", ...assigned]
    return [...env, ...self, "run", taskFile, "--branch", request.branch ?? taskBranch(request.task), "--sandbox", "none", "--provider", request.provider, ...kind, ...delivery, ...instructions, ...answers]
  })

const enqueueHeld = (
  home: string,
  request: QueueToken,
  key: string,
  self: Command,
  run: ReadonlyArray<string>,
  add: (command: ReadonlyArray<string>) => Effect.Effect<string, RunnerError, RunnerRequirements>,
  holdArgs: ReadonlyArray<string>
): Effect.Effect<string, RunnerError, RunnerRequirements> =>
  Effect.gen(function*() {
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

const queueTask = (
  request: QueueRequest,
  self: Command,
  home: string
): Effect.Effect<string, RunnerError, RunnerRequirements> =>
  Effect.gen(function*() {
    yield* checkQueueConfig(home, request)
    yield* requireFolder(request.checkout)
    const project = yield* resolveProjectDir(request.checkout)
    yield* requireResumeRun(home, project, request.branch ?? taskBranch(request.task), request.resumeRun)
    yield* ensureGroup(orcGroup)
    const label = runLabel(home, request.task, request.kind, request.label)
    const key = fileKeyOf(home, request.task, label)
    const held = yield* readHeld(home, request.task, label)
    if (held !== null && !pueueDone(held)) {
      return request.task + " is already pueue task " + held.id + " in group " + orcGroup
    }
    const taskFile = yield* writeTaskFile(home, key, request.body)
    const run = yield* buildRun(request, self, home, key, taskFile)
    const add = (command: ReadonlyArray<string>) =>
      pueue(["add", "--group", orcGroup, "--label", label, "--working-directory", project, "--print-task-id", "--escape", "--", ...command], { ORC_HOME: home })
    const holdArgs: ReadonlyArray<string> = label === taskLabel(home, request.task) ? [request.task] : [request.task, "--label", label]
    if ("tokenFile" in request) {
      const id = yield* add([...run, "--token-file", request.tokenFile])
      return "queued " + request.task + " as pueue task " + id.trim() + " in group " + orcGroup
    }
    if (!("token" in request)) {
      const id = yield* add(bareCommand(run, request.claudeConfigDir))
      return "queued " + request.task + " as pueue task " + id.trim() + " in group " + orcGroup
    }
    return yield* enqueueHeld(home, request, key, self, run, add, holdArgs)
  })

export const queueFromText = (text: string, self: Command, home: string): Effect.Effect<string, RunnerError, RunnerRequirements> =>
  decodeSecret(text, QueueRequest, queueRefusal).pipe(Effect.flatMap((request) => queueTask(request, self, home)))

export const pueueDone = (task: PueueTask): boolean =>
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
    const label = runLabel(home, request.task, request.kind)
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
