import { Console, DateTime, Effect, FileSystem, Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import type { DispatchArgs, TaskSource } from "./args"
import { addTask, backlogPaths, BacklogError, closeStartedTask, isTaskId, listTasks, markPosted } from "./backlog"
import { holdTask } from "./backlog-hold"
import { circularDependency, dependTask } from "./backlog-depend"
import { answerTask } from "./parked"
import { liveSources, readRoom, runBeat } from "./beat"
import { fiveMinuteLoad } from "./load"
import { backlogJson, type BacklogView, beatJson, formatBeat, formatBoard, type ProjectList, type RoomList } from "./board"
import type { ConfigError } from "../json-file"
import { checkoutOn, type DispatchConfig, readDispatchConfig, readProjects } from "./config"
import { holdRun } from "./hold"
import { mergeTask } from "./merge"
import { taskLabel } from "./pueue-status"
import { type Command, killHeld, queueFromText, refuse as refuseRun, renewTask, RunnerError, startTask } from "./runner"
import { formatResult, killHeldThrough, readResult, readResultThrough, readStdinLabel, relayAnswers, runnerJson } from "./runner-result"
import { throughFor } from "./machine-reach"
import type { TaskFileError, TaskRecord } from "./task-record"
import { encodeToken, sessionToken } from "./token"
import { markEventPosted, unpostedEvents } from "./events"
import { ensureAlertStream, liveAlertStream } from "./alert-stream"

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

const backlogRoot = (place: DispatchPlace): string => place.home + "/backlog"

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
    if (reading.kind === "unread") {
      return { tasks, events, projects: reading, room: reading }
    }
    const projects = yield* readProjects(paths.projects, reading.config.machines).pipe(
      Effect.map((list): ProjectList => ({ kind: "read", projects: list })),
      Effect.catchTag("ConfigError", (error) => Effect.succeed<ProjectList>({ kind: "unread", reason: failure(error) }))
    )
    const room: RoomList = { kind: "read", room: readRoom(reading.config.machines, tasks) }
    return { tasks, events, projects, room }
  })

const titleOf = (body: string): string =>
  body.split("\n").map((line) => line.replace(/^#+\s*/, "").trim()).find((line) => line !== "") ?? ""

const refuse = (detail: string) => Effect.fail(new BacklogError({ detail }))

const readSessionToken = (session: string, stdoutIsTerminal: boolean) =>
  Effect.gen(function*() {
    if (stdoutIsTerminal) {
      return yield* refuse("orc runner token prints a token, so it writes only into a pipe and never onto a terminal")
    }
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(session).pipe(
      Effect.mapError((error) => new BacklogError({ detail: "cannot read " + session + ": " + error.message }))
    )
    const reading = sessionToken(text)
    if (reading.kind === "unread") {
      return yield* refuse(session + " " + reading.reason)
    }
    return yield* encodeToken(reading.token).pipe(Effect.mapError((error) => new BacklogError({ detail: "the " + error.what + " would not encode" })))
  })

const refusedDependency = (dependsOn: ReadonlyArray<string>, tasks: ReadonlyArray<TaskRecord>): string | null =>
  dependsOn.find((id) => !isTaskId(id) || !tasks.some((task) => task.spec.id === id)) ?? null

const dependNow = (args: Extract<CommandArgs, { readonly kind: "DependTask" }>, place: DispatchPlace) =>
  Effect.gen(function*() {
    const tasks = yield* listTasks(backlogRoot(place))
    if (!tasks.some((task) => task.spec.id === args.id)) {
      return yield* refuse("the backlog holds no " + args.id)
    }
    const dependency = refusedDependency(args.dependsOn, tasks)
    if (dependency !== null) {
      return yield* refuse("the backlog holds no task " + dependency)
    }
    const loop = circularDependency(args.id, args.dependsOn, tasks)
    if (loop !== null) {
      return yield* refuse(loop)
    }
    const outcome = yield* dependTask(backlogRoot(place), args.id, args.dependsOn)
    const waits = args.dependsOn.length === 0 ? "no task" : args.dependsOn.join(", ")
    return args.id + (outcome === "set" ? " now waits on " : " already waits on ") + waits
  })

const backlogPresent = (root: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.exists(root).pipe(Effect.mapError((error) => new BacklogError({ detail: "cannot read " + root + ": " + error.message })))
  })

const noBacklog = (root: string): string => "no backlog at " + root + ": the backlog lives on the machine that runs orc beat, so run this command there"

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

interface TaskText {
  readonly from: string
  readonly body: string
}

const readTaskText = (source: TaskSource, place: DispatchPlace) =>
  Effect.gen(function*() {
    if (source.kind === "stdin") {
      if (place.stdinIsTerminal) {
        return yield* refuse("orc backlog add - reads the task from a pipe, and stdin is a terminal")
      }
      const body = yield* place.stdin.pipe(Effect.mapError((error) => new BacklogError({ detail: error.detail })))
      return { from: "the task on stdin", body } satisfies TaskText
    }
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const taskPath = path.resolve(place.cwd, source.path)
    const body = yield* fs.readFileString(taskPath).pipe(
      Effect.mapError((error) => new BacklogError({ detail: "cannot read the task file " + taskPath + ": " + error.message }))
    )
    return { from: "the task file " + taskPath, body } satisfies TaskText
  })

const add = (args: Extract<CommandArgs, { readonly kind: "AddTask" }>, place: DispatchPlace) =>
  Effect.gen(function*() {
    const paths = backlogPaths(backlogRoot(place))
    const config = yield* readDispatchConfig(paths.dispatchConfig)
    const project = (yield* readProjects(paths.projects, config.machines)).find((candidate) => candidate.name === args.project)
    if (project === undefined) {
      return yield* refuse("the project " + args.project + " is not in " + paths.projects)
    }
    if (args.machine !== null && checkoutOn(project, args.machine) === null) {
      return yield* refuse("the project " + args.project + " has no checkout on " + args.machine + " in " + paths.projects)
    }
    const dependency = refusedDependency(args.dependsOn, yield* listTasks(backlogRoot(place)))
    if (dependency !== null) {
      return yield* refuse("the backlog holds no task " + dependency)
    }
    const { from, body } = yield* readTaskText(args.task, place)
    const title = titleOf(body)
    if (title === "") {
      return yield* refuse(from + " holds no text")
    }
    const created = DateTime.formatIso(yield* DateTime.now)
    const record = yield* addTask(backlogRoot(place), {
      title,
      project: project.name,
      kind: args.taskKind,
      internal: args.internal,
      machine: args.machine,
      dependsOn: args.dependsOn,
      created,
      body
    })
    yield* Console.log(
      "added " + record.spec.id + " for " + project.name + (args.machine === null ? "" : " on " + args.machine) +
        (record.spec.kind === "ship" ? "" : " as a " + record.spec.kind) + (record.spec.internal ? " marked internal" : "")
    )
  })

const reportResult = (args: Extract<CommandArgs, { readonly kind: "RunnerResult" }>, place: DispatchPlace) =>
  Effect.gen(function*() {
    let label = args.label ?? taskLabel(place.home, args.task)
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
    yield* closeStartedTask(backlogRoot(place), args.id, args.outcome, args.reason, { pr: null, report: null }, DateTime.formatIso(yield* DateTime.now))
    return "closed " + args.id + " " + args.outcome
  })

const stopNow = (id: string, place: DispatchPlace) =>
  Effect.gen(function*() {
    const root = backlogRoot(place)
    const record = (yield* listTasks(root)).find((candidate) => candidate.spec.id === id)
    if (record === undefined) {
      return yield* refuseRun("the backlog holds no " + id)
    }
    if (record.state.kind !== "started") {
      return yield* refuseRun(id + " is " + record.state.kind + ", and only a started task stops")
    }
    const started = record.state
    const machine = (yield* readDispatchConfig(backlogPaths(root).dispatchConfig)).machines.find((entry) => entry.name === started.claim.machine)
    if (machine === undefined) {
      return yield* refuseRun("the machine " + started.claim.machine + " is not in dispatch.json")
    }
    const through = throughFor(machine)
    const label = taskLabel(place.home, id)
    const line = through === null
      ? yield* killHeld(place.home, id, label)
      : yield* killHeldThrough(through, id, label)
    const after = through === null
      ? yield* readResult(id, place.home, label).pipe(Effect.orElseSucceed(() => null))
      : yield* readResultThrough(through, id, label).pipe(Effect.orElseSucceed(() => null))
    const closed = after?.run ?? null
    yield* closeStartedTask(root, id, "stopped", closed?.endReason ?? "the captain stopped " + id, { pr: closed?.prLink ?? null, report: null }, DateTime.formatIso(yield* DateTime.now))
    return line
  })

const killNow = (args: Extract<CommandArgs, { readonly kind: "RunnerKill" }>, place: DispatchPlace) =>
  Effect.gen(function*() {
    let label = args.label ?? taskLabel(place.home, args.task)
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
    const answered = yield* answerTask(backlogRoot(place), args.id, args.words, DateTime.formatIso(yield* DateTime.now))
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

type TaskVerb = Extract<CommandArgs, { readonly kind: "CloseTask" | "MarkPosted" | "MarkEventPosted" | "HoldTask" | "AnswerTask" | "DependTask" | "MergeTask" }>

const taskVerbLine = (args: TaskVerb, place: DispatchPlace) => {
  switch (args.kind) {
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
      return Effect.succeed(String(fiveMinuteLoad()))
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
      case "ShowBacklog": {
        yield* Console.log(yield* backlogText(args.json, place))
        break
      }
      case "AddTask": {
        yield* add(args, place)
        break
      }
      case "CloseTask":
      case "MarkPosted":
      case "MarkEventPosted":
      case "HoldTask":
      case "AnswerTask":
      case "DependTask":
      case "MergeTask": {
        yield* requireBacklog(backlogRoot(place))
        yield* Console.log(yield* taskVerbLine(args, place))
        break
      }
      case "StopTask": {
        yield* requireBacklog(backlogRoot(place))
        yield* Console.log(yield* stopNow(args.id, place))
        break
      }
      case "Beat": {
        const report = yield* runBeat(backlogRoot(place), place.home, liveSources())
        yield* Console.log(args.json ? JSON.stringify(beatJson(report)) : formatBeat(report))
        break
      }
      case "RunnerStart": {
        const line = yield* startTask(place.env, place.stdin, args.reach, place.self, place.home)
        if (line !== null) {
          yield* Console.log(line)
        }
        yield* startAlertStream(place.home)
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
