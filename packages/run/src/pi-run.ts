import { Effect, Fiber, type FileSystem, Option, type Path, Schema, Stream } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { agentCommand, type AgentExec, type Argv, textInput } from "./agent-exec"
import type { AgentFile } from "./agents"
import { OrcRunError } from "./run-session"

export interface PiRequest {
  readonly agent: AgentFile
  readonly prompt: string
  readonly instructions: string | null
  readonly sessionDir: string
  readonly resumeSession: string | null
  readonly logFile: string
  readonly onSession: (file: string) => Effect.Effect<void, OrcRunError>
}

export interface PiPacing {
  readonly tickMillis: number
  readonly idleMillis: number
}

export type PiEnd =
  | { readonly kind: "exited"; readonly exitCode: number }
  | { readonly kind: "idle"; readonly idleMinutes: number }

export interface PiRun {
  readonly sessionId: string | null
  readonly sessionFile: string | null
  readonly end: PiEnd
}

export type PiLine =
  | { readonly kind: "session"; readonly id: string; readonly file: string }
  | { readonly kind: "reply"; readonly text: string }
  | { readonly kind: "tool-start"; readonly id: string; readonly label: string }
  | { readonly kind: "tool-end"; readonly id: string }
  | { readonly kind: "other" }

interface RunningTool {
  readonly label: string
  readonly since: number
}

const minuteMillis = 60_000

export const piArgv = (request: Pick<PiRequest, "agent" | "instructions" | "sessionDir" | "resumeSession">): Argv => [
  "pi", "-p", "--mode", "json",
  "--model", request.agent.model,
  "--thinking", request.agent.thinking,
  "--session-dir", request.sessionDir,
  ...(request.resumeSession === null ? [] : ["--session", request.resumeSession]),
  "--tools", request.agent.tools.join(","),
  ...(request.instructions === null ? [] : ["--append-system-prompt", request.instructions])
]

const SessionHeader = Schema.Struct({ type: Schema.Literal("session"), id: Schema.String, timestamp: Schema.String })

const ReplyEnd = Schema.Struct({
  type: Schema.Literal("message_end"),
  message: Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }))
  })
})

const ToolStart = Schema.Struct({ type: Schema.Literal("tool_execution_start"), toolCallId: Schema.String, toolName: Schema.String, args: Schema.optional(Schema.Unknown) })

const ToolEnd = Schema.Struct({ type: Schema.Literal("tool_execution_end"), toolCallId: Schema.String })

const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Union([SessionHeader, ReplyEnd, ToolStart, ToolEnd])))

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
          return { kind: "tool-start", id: event.toolCallId, label: toolLabel(event.toolName, event.args) }
        case "tool_execution_end":
          return { kind: "tool-end", id: event.toolCallId }
      }
    }
  })

export const stillRunningLines = (running: Iterable<RunningTool>, now: number): ReadonlyArray<string> =>
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
    const handle = yield* spawner.spawn(agentCommand(exec, piArgv(request), textInput(request.prompt))).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: pi did not start: " + String(cause) }))
    )
    const running = new Map<string, RunningTool>()
    const state: { lastOutput: number; session: { readonly id: string; readonly file: string } | null; idleMinutes: number | null } = {
      lastOutput: Date.now(),
      session: null,
      idleMinutes: null
    }
    const onLine = (line: string): Effect.Effect<void, OrcRunError> =>
      Effect.gen(function*() {
        state.lastOutput = Date.now()
        const read = readPiLine(line, request.sessionDir)
        if (read.kind === "session" && state.session === null) {
          state.session = { id: read.id, file: read.file }
          yield* log("orc: pi session " + read.file)
          yield* request.onSession(read.file)
        } else if (read.kind === "reply" && read.text !== "") {
          yield* log(read.text)
        } else if (read.kind === "tool-start") {
          running.set(read.id, { label: read.label, since: state.lastOutput })
          yield* log("> " + read.label)
        } else if (read.kind === "tool-end") {
          running.delete(read.id)
        }
      })
    const watch = Effect.gen(function*() {
      const now = Date.now()
      for (const line of stillRunningLines(running.values(), now)) {
        yield* log("orc: " + line)
      }
      if (running.size === 0 && now - state.lastOutput >= pacing.idleMillis) {
        const idleMinutes = Math.floor((now - state.lastOutput) / minuteMillis)
        state.idleMinutes = idleMinutes
        yield* log("orc: stopped pi after " + idleMinutes.toString() + " min with no output and no tool running")
        yield* handle.kill().pipe(Effect.catch((cause) => log("orc: cannot stop pi: " + String(cause))))
      }
    }).pipe(Effect.delay(pacing.tickMillis), Effect.forever)
    const watcher = yield* Effect.forkScoped(watch)
    const [, , exitCode] = yield* Effect.all([
      handle.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.mapError((cause) => new OrcRunError({ message: "orc: cannot read pi's output: " + String(cause) })),
        Stream.runForEach(onLine)
      ),
      handle.stderr.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.mapError((cause) => new OrcRunError({ message: "orc: cannot read pi's errors: " + String(cause) })),
        Stream.runForEach((line) => line.trim() === "" ? Effect.void : log("pi: " + line))
      ),
      handle.exitCode.pipe(Effect.map((code): number => code), Effect.orElseSucceed(() => 128))
    ], { concurrency: "unbounded" })
    yield* Fiber.interrupt(watcher)
    const session = state.session
    const found = session === null ? null : yield* findSessionFile(fs, path, request.sessionDir, session.id, session.file)
    const end: PiEnd = state.idleMinutes === null ? { kind: "exited", exitCode } : { kind: "idle", idleMinutes: state.idleMinutes }
    return { sessionId: session?.id ?? null, sessionFile: found, end }
  }))
