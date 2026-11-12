import { Console, DateTime, Effect, FileSystem, Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import type { DispatchArgs } from "./args"
import { backlogPaths, BacklogError, closeStartedTask, findTask, listTasks, markPosted, runLabel, backlogPresent, backlogRoot as backlogRootOf, noBacklog, type TaskFileError } from "../entities/backlog/index"
import { readAttention, routeTaskItems } from "./attention"
import { deciderOwnership } from "./beat-attention"
import { answerItemText, attentionText } from "./attention-view"
import { holdTask } from "./backlog-hold"
import { dropChild, planText } from "./backlog-plan"
import { circularDependency, dependTask, refusedLinks } from "./backlog-depend"
import { answerTask } from "./parked"
import { liveSources, readRoom, runBeat } from "./beat"
import { runnerLoadText } from "./load"
import { backlogJson, type BacklogView, beatJson, formatBeat, formatBoard, type ProjectList, type RoomList } from "./board"
import { type ConfigError, readFailure } from "../shared/config/index"
import { type DispatchConfig, readDispatchConfig, readProjects } from "../shared/config/index"
import { holdRun } from "./hold"
import { mergeTask } from "./merge"
import { killHeld, queueFromText, renewTask, startTask } from "./runner"
import { RunnerError } from "../shared/process/index"
import { type Command } from "../shared/process/index"
import { stopNow } from "./cli-stop"
import { formatResult, readResult, readResultThrough, readStdinLabel, relayAnswers, runnerJson } from "./runner-result"
import { add } from "./cli-add"
import { encodeToken, sessionToken } from "./token"
import { markEventPosted, mergedIds, unpostedEvents } from "./events"
import { ensureAlertStream, liveAlertStream } from "./alert-stream"
import { runHeavy, startHeavyWatch } from "./heavy-cli"

type CommandArgs = Exclude<DispatchArgs, { readonly kind: "UsageError" }>

export interface DispatchPlace {
  readonly home: string
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly self: Command
  readonly stdin: Effect.Effect<string, RunnerError>
  readonly stdinIsTerminal: boolean
  readonly stdoutIsTerminal: boolean
}

const backlogRoot = (place: DispatchPlace): string => backlogRootOf(place.home)

type CliRequirements = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner

const failure = (error: BacklogError | ConfigError | TaskFileError | RunnerError): string =>
  error instanceof BacklogError || error instanceof RunnerError ? error.detail : error.file + ": " + error.detail

type ConfigReading = { readonly kind: "read"; readonly config: DispatchConfig } | { readonly kind: "unread"; readonly reason: string }

const readView = (root: string): Effect.Effect<BacklogView, BacklogError | TaskFileError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const paths = backlogPaths(root)
    const tasks = yield* listTasks(root)
    const reading = yield* readDispatchConfig(paths.dispatchConfig).pipe(
      Effect.map((config): ConfigReading => ({ kind: "read", config })),
      Effect.catchTag("ConfigError", (error) => Effect.succeed<ConfigReading>({ kind: "unread", reason: failure(error) }))
    )
    const events = yield* unpostedEvents(root)
    const merged = yield* mergedIds(root)
    const deciderOwns = deciderOwnership(yield* readAttention(root, tasks))
    if (reading.kind === "unread") {
      return { tasks, events, projects: reading, room: reading, merged, deciderOwns }
    }
    const projects = yield* readProjects(paths.projects, reading.config.machines).pipe(
      Effect.map((list): ProjectList => ({ kind: "read", projects: list })),
      Effect.catchTag("ConfigError", (error) => Effect.succeed<ProjectList>({ kind: "unread", reason: failure(error) }))
    )
    const room: RoomList = { kind: "read", room: readRoom(reading.config.machines, tasks) }
    return { tasks, events, projects, room, merged, deciderOwns }
  })

const refuse = (detail: string) => Effect.fail(new BacklogError({ detail }))

const readSessionToken = (session: string, stdoutIsTerminal: boolean) =>
  Effect.gen(function*() {
    if (stdoutIsTerminal) {
      return yield* refuse("orc runner token prints a token, so it writes only into a pipe and never onto a terminal")
    }
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(session).pipe(
      Effect.mapError((error) => new BacklogError({ detail: "cannot read " + session + ": " + readFailure(error) }))
    )
    const reading = sessionToken(text)
    if (reading.kind === "unread") {
      return yield* refuse(session + " " + reading.reason)
    }
    return yield* encodeToken(reading.token).pipe(Effect.mapError((error) => new BacklogError({ detail: "the " + error.what + " would not encode" })))
  })

const dependNow = (args: Extract<CommandArgs, { readonly kind: "DependTask" }>, place: DispatchPlace) =>
  Effect.gen(function*() {
    const tasks = yield* listTasks(backlogRoot(place))
    if (!tasks.some((task) => task.spec.id === args.id)) {
      return yield* refuse("the backlog holds no " + args.id)
    }
    const missing = refusedLinks(null, args.dependsOn, tasks)
    if (missing !== null) {
      return yield* refuse(missing)
    }
    const loop = circularDependency(args.id, args.dependsOn, tasks)
    if (loop !== null) {
      return yield* refuse(loop)
    }
    const outcome = yield* dependTask(backlogRoot(place), args.id, args.dependsOn)
    const waits = args.dependsOn.length === 0 ? "no task" : args.dependsOn.join(", ")
    return args.id + (outcome === "set" ? " now waits on " : " already waits on ") + waits
  })

const backlogText = (json: boolean, place: DispatchPlace) =>
  Effect.gen(function*() {
    if (!json && !(yield* backlogPresent(backlogRoot(place)))) {
      return noBacklog(backlogRoot(place))
    }
    const view = yield* readView(backlogRoot(place))
    return json ? JSON.stringify(backlogJson(view)) : formatBoard(view)
  })

const requireBacklog = (root: string) =>
  Effect.gen(function*() {
    if (!(yield* backlogPresent(root))) {
      return yield* refuse(noBacklog(root))
    }
  })

const defaultKind = (place: DispatchPlace, task: string) =>
  findTask(backlogRoot(place), task).pipe(
    Effect.map((record) => record.spec.kind),
    Effect.orElseSucceed(() => undefined)
  )

const reportResult = (args: Extract<CommandArgs, { readonly kind: "RunnerResult" }>, place: DispatchPlace) =>
  Effect.gen(function*() {
    let label = runLabel(place.home, args.task, args.label === undefined ? yield* defaultKind(place, args.task) : undefined, args.label)
    // An open pipe that never closes would hang a stdin read, so only a forwarded read marked on argv reads the piped label.
    if (args.reach.kind === "here" && args.label === undefined && args.stdinLabel && !place.stdinIsTerminal) {
      label = (yield* readStdinLabel(place.stdin)) ?? label
    }
    const result = args.reach.kind === "here"
      ? yield* readResult(args.task, place.home, label)
      : yield* readResultThrough(args.reach.command, args.task, label)
    yield* Console.log(args.json ? JSON.stringify(runnerJson(result)) : formatResult(result))
  })

const closeNow = (args: Extract<CommandArgs, { readonly kind: "CloseTask" }>, place: DispatchPlace) =>
  Effect.gen(function*() {
    const at = DateTime.formatIso(yield* DateTime.now)
    const closed = yield* closeStartedTask(backlogRoot(place), args.id, args.outcome, args.reason, { pr: null, report: null }, at)
    yield* routeTaskItems(backlogRoot(place), [closed], at)
    return "closed " + args.id + " " + args.outcome
  })

const killNow = (args: Extract<CommandArgs, { readonly kind: "RunnerKill" }>, place: DispatchPlace) =>
  Effect.gen(function*() {
    let label = runLabel(place.home, args.task, args.label === undefined ? yield* defaultKind(place, args.task) : undefined, args.label)
    if (args.label === undefined && args.stdinLabel && !place.stdinIsTerminal) {
      label = (yield* readStdinLabel(place.stdin)) ?? label
    }
    return yield* killHeld(place.home, args.task, label)
  })

const markPostedNow = (id: string, place: DispatchPlace) =>
  Effect.gen(function*() {
    const marked = yield* markPosted(backlogRoot(place), id, DateTime.formatIso(yield* DateTime.now))
    return (marked ? "posted " : "already posted ") + id
  })

const markEventPostedNow = (key: string, place: DispatchPlace) =>
  markEventPosted(backlogRoot(place), key).pipe(Effect.map((marked) => (marked ? "posted " : "already posted ") + key))

const holdNow = (args: Extract<CommandArgs, { readonly kind: "HoldTask" }>, place: DispatchPlace) =>
  holdTask(backlogRoot(place), args.id, { reason: args.reason, until: args.until, questions: args.questions }).pipe(
    Effect.map((outcome) =>
      (outcome.kind === "held" ? "held " + args.id : args.id + " is already held") + ": " + outcome.hold.reason +
      (outcome.hold.until === null ? "" : ", until " + outcome.hold.until) +
      (outcome.hold.questions.length === 0 ? "" : ", on " + outcome.hold.questions.map((question) => question.id).join(", "))
    )
  )

const answerNow = (args: Extract<CommandArgs, { readonly kind: "AnswerTask" }>, place: DispatchPlace) =>
  Effect.gen(function*() {
    const at = DateTime.formatIso(yield* DateTime.now)
    const answered = yield* answerTask(backlogRoot(place), args.id, args.words, at)
    yield* routeTaskItems(backlogRoot(place), [yield* findTask(backlogRoot(place), args.id)], at)
    if (answered.kind === "hold") {
      return "answered " + args.id + ", so the beat may start it"
    }
    if (answered.kind === "held question") {
      return answered.open.length === 0
        ? "answered " + answered.question + " on " + args.id + ", so the beat may start it"
        : "answered " + answered.question + " on " + args.id + ", and it stays held for " + answered.open.map((question) => question.id).join(", ")
    }
    if (answered.live) {
      return "answered " + answered.question + " on " + args.id + ", so the next beat hands it to the run waiting on " + answered.branch
    }
    return answered.open.length === 0
      ? "answered " + answered.question + " on " + args.id + ", so the beat resumes it on " + answered.branch
      : "answered " + answered.question + " on " + args.id + ", and it stays parked for " + answered.open.map((question) => question.id).join(", ")
  })

type TaskVerb = Extract<CommandArgs, { readonly kind: "AnswerItem" | "CloseTask" | "MarkPosted" | "MarkEventPosted" | "HoldTask" | "AnswerTask" | "DependTask" | "MergeTask" | "ShowPlan" | "DropChild" }>

const taskVerbLine = (args: TaskVerb, place: DispatchPlace) => {
  switch (args.kind) {
    case "AnswerItem": {
      return DateTime.now.pipe(Effect.flatMap((now) => answerItemText(backlogRoot(place), args.id, { words: args.words, at: DateTime.formatIso(now) })))
    }
    case "CloseTask": {
      return closeNow(args, place)
    }
    case "MarkPosted": {
      return markPostedNow(args.id, place)
    }
    case "MarkEventPosted": {
      return markEventPostedNow(args.key, place)
    }
    case "HoldTask": {
      return holdNow(args, place)
    }
    case "AnswerTask": {
      return answerNow(args, place)
    }
    case "DependTask": {
      return dependNow(args, place)
    }
    case "MergeTask": {
      return mergeTask(backlogRoot(place), args.id, args.basis)
    }
    case "ShowPlan": {
      return planText(backlogRoot(place), args.parent)
    }
    case "DropChild": {
      return dropChild(backlogRoot(place), args.parent, args.child)
    }
  }
}

type RunnerVerb = Extract<CommandArgs, { readonly kind: "RunnerHold" | "RunnerKill" | "RunnerToken" | "RunnerQueue" | "RunnerAnswer" | "RunnerLoad" }>

const runnerVerbLine = (args: RunnerVerb, place: DispatchPlace) => {
  switch (args.kind) {
    case "RunnerHold": {
      return holdRun(args.task, args.run, place.home, args.label)
    }
    case "RunnerKill": {
      return killNow(args, place)
    }
    case "RunnerToken": {
      return readSessionToken(args.session, place.stdoutIsTerminal)
    }
    case "RunnerQueue": {
      return place.stdin.pipe(Effect.flatMap((text) => queueFromText(text, place.self, place.home)))
    }
    case "RunnerAnswer": {
      return relayAnswers(place.home, args.task, place.stdin)
    }
    case "RunnerLoad": {
      return runnerLoadText(place.home)
    }
  }
}

// The task is queued by now, so a stream that will not queue is told in the task's log and fails no task.
const startAlertStream = (home: string) => {
  const stream = liveAlertStream()
  return stream === null
    ? Effect.void
    : ensureAlertStream(home, stream).pipe(
      Effect.flatMap((line) => line === null ? Effect.void : Console.log(line)),
      Effect.catchTag("RunnerError", (error) => Console.error("orc runner start queued no alert stream: " + error.detail))
    )
}

const execute = (args: CommandArgs, place: DispatchPlace) =>
  Effect.gen(function*() {
    switch (args.kind) {
      case "ShowBacklog":
      case "ShowAttention": {
        yield* Console.log(yield* (args.kind === "ShowBacklog" ? backlogText(args.json, place) : attentionText(args.json, backlogRoot(place))))
        break
      }
      case "AddTask": {
        yield* add(args, place)
        break
      }
      case "AnswerItem":
      case "CloseTask":
      case "MarkPosted":
      case "MarkEventPosted":
      case "HoldTask":
      case "AnswerTask":
      case "DependTask":
      case "MergeTask":
      case "ShowPlan":
      case "DropChild": {
        yield* requireBacklog(backlogRoot(place))
        yield* Console.log(yield* taskVerbLine(args, place))
        break
      }
      case "StopTask": {
        yield* requireBacklog(backlogRoot(place))
        yield* Console.log(yield* stopNow(args.id, backlogRoot(place), place.home))
        break
      }
      case "Beat": {
        const report = yield* runBeat(backlogRoot(place), place.home, liveSources(place.home))
        yield* Console.log(args.json ? JSON.stringify(beatJson(report)) : formatBeat(report))
        break
      }
      case "RunnerStart": {
        const line = yield* startTask(place.env, place.stdin, args.reach, place.self, place.home)
        if (line !== null) {
          yield* Console.log(line)
        }
        yield* startAlertStream(place.home)
        yield* startHeavyWatch(place.home, place.self, "orc runner start")
        break
      }
      case "HeavyPath":
      case "HeavyCheck":
      case "HeavyWatch":
      case "HeavyWatchOnce": {
        yield* runHeavy(args, place)
        break
      }
      case "RunnerRenew": {
        const line = yield* renewTask(place.stdin, args.reach, place.home)
        if (line !== null) {
          yield* Console.log(line)
        }
        break
      }
      case "RunnerResult": {
        yield* reportResult(args, place)
        break
      }
      case "RunnerHold":
      case "RunnerKill":
      case "RunnerToken":
      case "RunnerQueue":
      case "RunnerAnswer":
      case "RunnerLoad": {
        yield* Console.log(yield* runnerVerbLine(args, place))
        break
      }
    }
  })

export const runDispatch = (args: CommandArgs, place: DispatchPlace): Effect.Effect<void, string, CliRequirements> =>
  execute(args, place).pipe(Effect.mapError(failure))
