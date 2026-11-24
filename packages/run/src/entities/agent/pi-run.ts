import { Effect, Fiber, FileSystem, Option, type Path, Schema, Stream } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { agentCommand, type AgentExec, type Argv, textInput } from "../../shared/sandbox/index"
import type { AgentFile } from "./agents"
import { OrcRunError, workerCiInstructions } from "../../shared/lib/index"
import { writeWhole } from "../../shared/config/index"
import { askAfterFailures, type FailingMark, type FailureStreak, nextStreak, pauseAfterFailures } from "./failure-streak"
import { askDirFlag, askToolName } from "./orc-ask-extension"
import { askExtensionSource, type AskedQuestion, type AskSetup, type WorkerAsks, openWorkerAsks } from "./worker-ask"

export interface PiRequest {
  readonly agent: AgentFile
  readonly prompt: string
  readonly instructions: string | null
  readonly sessionDir: string
  readonly resumeSession: string | null
  readonly logFile: string
  readonly failingFile: string
  readonly asks: AskSetup
  readonly withoutAsks?: true | undefined
  readonly onSession: (file: string) => Effect.Effect<void, OrcRunError>
}

export interface PiPacing {
  readonly tickMillis: number
  readonly idleMillis: number
  readonly minuteMillis?: number
}

export type PiEnd =
  | { readonly kind: "exited"; readonly exitCode: number }
  | { readonly kind: "idle"; readonly idleSeconds: number }
  | { readonly kind: "looping"; readonly label: string }
  | { readonly kind: "asked"; readonly question: AskedQuestion }

export interface PiRun {
  readonly sessionId: string | null
  readonly sessionFile: string | null
  readonly end: PiEnd
}

export type PiLine =
  | { readonly kind: "session"; readonly id: string; readonly file: string }
  | { readonly kind: "reply"; readonly text: string }
  | { readonly kind: "tool-start"; readonly id: string; readonly label: string; readonly command: string | null }
  | { readonly kind: "tool-end"; readonly id: string; readonly failed: boolean }
  | { readonly kind: "ask"; readonly id: string; readonly args: unknown }
  | { readonly kind: "turn-end" }
  | { readonly kind: "other" }

interface RunningTool {
  readonly label: string
  readonly command: string | null
  readonly since: number
}

const defaultMinuteMillis = 60_000

const askPollMillis = 1000

export const idleSpan = (seconds: number): string =>
  seconds < 120 ? seconds.toString() + (seconds === 1 ? " second" : " seconds") : Math.floor(seconds / 60).toString() + " min"

export const piArgv = (request: Pick<PiRequest, "agent" | "instructions" | "sessionDir" | "resumeSession" | "asks" | "withoutAsks">): Argv => [
  "pi", "-p", "--mode", "json",
  "--model", request.agent.model,
  "--thinking", request.agent.thinking,
  "--session-dir", request.sessionDir,
  ...(request.resumeSession === null ? [] : ["--session", request.resumeSession]),
  ...(request.withoutAsks === true ? [] : ["--extension", request.asks.extensionFile, "--" + askDirFlag, request.asks.askDir]),
  "--tools", (request.withoutAsks === true ? request.agent.tools : [...request.agent.tools, askToolName]).join(","),
  ...(request.instructions === null ? [] : ["--append-system-prompt", request.instructions])
]

const SessionHeader = Schema.Struct({ type: Schema.Literal("session"), id: Schema.String, timestamp: Schema.String })

export const assistantContent = Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }))

const ReplyEnd = Schema.Struct({
  type: Schema.Literal("message_end"),
  message: Schema.Struct({
    role: Schema.Literal("assistant"),
    content: assistantContent
  })
})

const ToolStart = Schema.Struct({ type: Schema.Literal("tool_execution_start"), toolCallId: Schema.String, toolName: Schema.String, args: Schema.optional(Schema.Unknown) })

const ToolEnd = Schema.Struct({ type: Schema.Literal("tool_execution_end"), toolCallId: Schema.String, isError: Schema.optional(Schema.Boolean) })

const TurnEnd = Schema.Struct({ type: Schema.Literal("turn_end") })

const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Union([SessionHeader, ReplyEnd, ToolStart, ToolEnd, TurnEnd])))

// Pi names a new session file after its header's timestamp with ':' and '.' replaced, so the path is known before Pi writes the file.
export const sessionFileName = (id: string, timestamp: string): string => timestamp.replace(/[:.]/g, "-") + "_" + id + ".jsonl"

const commandOf = (args: unknown): string | null =>
  typeof args === "object" && args !== null && "command" in args && typeof args.command === "string" ? args.command : null

export const toolLabel = (name: string, args: unknown): string => {
  const lines = (commandOf(args) ?? "").trim().split("\n")
  const first = lines[0] ?? ""
  return first === "" ? name : first + (lines.length > 1 ? " …" : "")
}

export const readPiLine = (line: string, sessionDir: string): PiLine =>
  Option.match(decodeEvent(line), {
    onNone: (): PiLine => ({ kind: "other" }),
    onSome: (event): PiLine => {
      switch (event.type) {
        case "session":
          return { kind: "session", id: event.id, file: sessionDir + "/" + sessionFileName(event.id, event.timestamp) }
        case "message_end":
          return { kind: "reply", text: event.message.content.flatMap((block) => block.type === "text" && block.text !== undefined ? [block.text] : []).join("\n").trim() }
        case "tool_execution_start":
          return event.toolName === askToolName
            ? { kind: "ask", id: event.toolCallId, args: event.args }
            : { kind: "tool-start", id: event.toolCallId, label: toolLabel(event.toolName, event.args), command: commandOf(event.args) }
        case "tool_execution_end":
          return { kind: "tool-end", id: event.toolCallId, failed: event.isError === true }
        case "turn_end":
          return { kind: "turn-end" }
      }
    }
  })

export const stillRunningLines = (running: Iterable<Pick<RunningTool, "label" | "since">>, now: number, minuteMillis: number = defaultMinuteMillis): ReadonlyArray<string> =>
  [...running].flatMap((tool) => {
    const minutes = Math.floor((now - tool.since) / minuteMillis)
    return minutes < 1 ? [] : ["still running " + tool.label + " (" + minutes.toString() + " min)"]
  })

const findSessionFile = (fs: FileSystem.FileSystem, path: Path.Path, sessionDir: string, id: string, named: string): Effect.Effect<string | null> =>
  Effect.gen(function*() {
    if (yield* fs.exists(named).pipe(Effect.orElseSucceed(() => false))) {
      return named
    }
    const files = yield* fs.readDirectory(sessionDir).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
    const found = files.find((file) => file.endsWith("_" + id + ".jsonl"))
    return found === undefined ? null : path.join(sessionDir, found)
  })

interface FailureWatch {
  streak: FailureStreak | null
  looping: string | null
}

interface FailureSink {
  readonly fs: FileSystem.FileSystem
  readonly failingFile: string
  readonly log: (text: string) => Effect.Effect<void, OrcRunError>
  readonly stop: Effect.Effect<void, OrcRunError>
}

const clearFailing = (fs: FileSystem.FileSystem, failingFile: string): Effect.Effect<void> =>
  fs.remove(failingFile, { force: true }).pipe(Effect.orElseSucceed(() => undefined))

const countFailure = (watch: FailureWatch, sink: FailureSink, tool: { readonly label: string; readonly command: string }, failed: boolean): Effect.Effect<void, OrcRunError> =>
  Effect.gen(function*() {
    const before = watch.streak
    const after = nextStreak(before, tool.command, failed)
    watch.streak = after
    if ((before?.failures ?? 0) >= askAfterFailures && (after?.failures ?? 0) < askAfterFailures) {
      yield* clearFailing(sink.fs, sink.failingFile)
    }
    if (after?.failures === askAfterFailures) {
      const mark: FailingMark = { label: tool.label, since: new Date().toISOString() }
      yield* sink.log("orc: pi failed " + tool.label + " " + askAfterFailures.toString() + " times in a row")
      yield* writeWhole(sink.failingFile, JSON.stringify(mark)).pipe(Effect.provideService(FileSystem.FileSystem, sink.fs))
    }
    if (after?.failures === pauseAfterFailures) {
      watch.looping = tool.label
      yield* sink.log("orc: stopped pi, it failed " + tool.label + " " + pauseAfterFailures.toString() + " times in a row")
      yield* clearFailing(sink.fs, sink.failingFile)
      yield* sink.stop
    }
  })

const placeAskExtension = (fs: FileSystem.FileSystem, request: PiRequest): Effect.Effect<void, OrcRunError> =>
  fs.makeDirectory(request.asks.askDir, { recursive: true }).pipe(
    Effect.andThen(fs.readFileString(askExtensionSource)),
    Effect.flatMap((source) => fs.writeFileString(request.asks.extensionFile, source)),
    Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot place the orc_ask extension at " + request.asks.extensionFile + ": " + String(cause) }))
  )

interface PiProgress {
  lastOutput: number
  session: { readonly id: string; readonly file: string } | null
  idleSeconds: number | null
  stoppedForAnswer: boolean
}

interface PiLineContext {
  readonly running: Map<string, RunningTool>
  readonly progress: PiProgress
  readonly watch: FailureWatch
  readonly asks: WorkerAsks
  readonly sink: FailureSink
  readonly stopPi: Effect.Effect<void, OrcRunError>
  readonly log: (text: string) => Effect.Effect<void, OrcRunError>
  readonly sessionDir: string
  readonly onSession: (file: string) => Effect.Effect<void, OrcRunError>
}

const handlePiLine = (context: PiLineContext, line: string): Effect.Effect<void, OrcRunError> =>
  Effect.gen(function*() {
    context.progress.lastOutput = Date.now()
    const read = readPiLine(line, context.sessionDir)
    if (read.kind === "session" && context.progress.session === null) {
      context.progress.session = { id: read.id, file: read.file }
      yield* context.log("orc: pi session " + read.file)
      yield* context.onSession(read.file)
    } else if (read.kind === "reply" && read.text !== "") {
      yield* context.log(read.text)
    } else if (read.kind === "tool-start") {
      context.running.set(read.id, { label: read.label, command: read.command, since: context.progress.lastOutput })
      yield* context.log("> " + read.label)
    } else if (read.kind === "ask") {
      context.running.set(read.id, { label: askToolName, command: null, since: context.progress.lastOutput })
      yield* context.log("> " + askToolName)
    } else if (read.kind === "turn-end") {
      const late = context.asks.timedOut()
      if (late !== null && !context.progress.stoppedForAnswer) {
        context.progress.stoppedForAnswer = true
        yield* context.log("orc: stopped pi, no answer to " + late.id + " came in time")
        yield* context.stopPi
      }
    } else if (read.kind === "tool-end") {
      const tool = context.running.get(read.id)
      context.running.delete(read.id)
      if (tool !== undefined && tool.command !== null && context.watch.looping === null) {
        yield* countFailure(context.watch, context.sink, { label: tool.label, command: tool.command }, read.failed)
      }
    }
  })

interface PiIdleContext {
  readonly running: Map<string, RunningTool>
  readonly progress: PiProgress
  readonly pacing: PiPacing
  readonly log: (text: string) => Effect.Effect<void, OrcRunError>
  readonly stopPi: Effect.Effect<void, OrcRunError>
}

const stopWhenIdle = (context: PiIdleContext): Effect.Effect<void, OrcRunError> => Effect.suspend(() => {
  const quietMillis = Date.now() - context.progress.lastOutput
  if (quietMillis < context.pacing.idleMillis) {
    return Effect.sleep(context.pacing.idleMillis - quietMillis).pipe(Effect.andThen(stopWhenIdle(context)))
  }
  if (context.running.size > 0) {
    return Effect.sleep(context.pacing.idleMillis).pipe(Effect.andThen(stopWhenIdle(context)))
  }
  const idleSeconds = Math.floor(quietMillis / 1000)
  context.progress.idleSeconds = idleSeconds
  return context.log("orc: stopped pi, idle for " + idleSpan(idleSeconds) + " with no tool running").pipe(
    Effect.andThen(context.stopPi))
})

const piEndOf = (exitCode: number, progress: PiProgress, watch: FailureWatch, asked: AskedQuestion | null): PiEnd =>
  asked !== null
    ? { kind: "asked", question: asked }
    : watch.looping !== null
    ? { kind: "looping", label: watch.looping }
    : progress.idleSeconds === null ? { kind: "exited", exitCode } : { kind: "idle", idleSeconds: progress.idleSeconds }

// Pi prints nothing while a tool runs, so silence alone never stops it: a quiet test run is work, not a hang.
export const runPi = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  fs: FileSystem.FileSystem,
  path: Path.Path,
  exec: AgentExec,
  request: PiRequest,
  pacing: PiPacing
): Effect.Effect<PiRun, OrcRunError> =>
  Effect.scoped(Effect.gen(function*() {
    const log = (text: string) =>
      fs.writeFileString(request.logFile, text + "\n", { flag: "a" }).pipe(
        Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot write " + request.logFile + ": " + String(cause) }))
      )
    yield* fs.writeFileString(request.logFile, "", { flag: "a" }).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot write " + request.logFile + ": " + String(cause) }))
    )
    if (request.withoutAsks !== true) {
      yield* placeAskExtension(fs, request)
    }
    const asks = openWorkerAsks(fs, request.asks)
    const prompt = workerCiInstructions + "\n\n" + request.prompt
    const handle = yield* spawner.spawn(agentCommand(exec, piArgv(request), textInput(prompt))).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: pi did not start: " + String(cause) }))
    )
    const running = new Map<string, RunningTool>()
    const progress: PiProgress = {
      lastOutput: Date.now(),
      session: null,
      idleSeconds: null,
      stoppedForAnswer: false
    }
    const watch: FailureWatch = { streak: null, looping: null }
    const stopPi = handle.kill().pipe(Effect.catch((cause) => log("orc: cannot stop pi: " + String(cause))))
    const sink: FailureSink = { fs, failingFile: request.failingFile, log, stop: stopPi }
    const lines: PiLineContext = { running, progress, watch, asks, sink, stopPi, log, sessionDir: request.sessionDir, onSession: request.onSession }
    const idle: PiIdleContext = { running, progress, pacing, log, stopPi }
    const report = Effect.suspend(() => Effect.forEach(stillRunningLines(running.values(), Date.now(), pacing.minuteMillis ?? defaultMinuteMillis), (line) => log("orc: " + line))).pipe(
      Effect.delay(pacing.tickMillis),
      Effect.forever
    )
    const pollAsks = asks.tick.pipe(Effect.delay(askPollMillis), Effect.forever)
    const watchers = [yield* Effect.forkScoped(report), yield* Effect.forkScoped(stopWhenIdle(idle)), yield* Effect.forkScoped(pollAsks)]
    const [, , exitCode] = yield* Effect.all([
      handle.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.mapError((cause) => new OrcRunError({ message: "orc: cannot read pi's output: " + String(cause) })),
        Stream.runForEach((line) => handlePiLine(lines, line))
      ),
      handle.stderr.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.mapError((cause) => new OrcRunError({ message: "orc: cannot read pi's errors: " + String(cause) })),
        Stream.runForEach((line) => line.trim() === "" ? Effect.void : log("pi: " + line))
      ),
      handle.exitCode.pipe(Effect.map((code): number => code), Effect.orElseSucceed(() => 128))
    ], { concurrency: "unbounded" })
    yield* Fiber.interruptAll(watchers)
    const session = progress.session
    const found = session === null ? null : yield* findSessionFile(fs, path, request.sessionDir, session.id, session.file)
    return { sessionId: session?.id ?? null, sessionFile: found, end: piEndOf(exitCode, progress, watch, asks.timedOut()) }
  })).pipe(Effect.ensuring(clearFailing(fs, request.failingFile)))
