import { Console, DateTime, Effect, FileSystem, Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import type { DispatchArgs } from "./args"
import { addTask, backlogPaths, BacklogError, closeStartedTask, isTaskId, listTasks } from "./backlog"
import { readRoom, runBeat } from "./beat"
import { backlogJson, type BacklogView, beatJson, formatBeat, formatBoard, type ProjectList, type RoomList } from "./board"
import type { ConfigError } from "../json-file"
import { checkoutOn, type DispatchConfig, readDispatchConfig, readProjects } from "./config"
import { holdRun } from "./hold"
import { type Command, queueFromText, renewTask, RunnerError, startTask } from "./runner"
import { formatResult, readResult, readResultThrough, runnerJson } from "./runner-result"
import type { TaskFileError, TaskRecord } from "./task-record"
import { encodeToken, sessionToken } from "./token"

type CommandArgs = Exclude<DispatchArgs, { readonly kind: "UsageError" }>

export interface DispatchPlace {
  readonly home: string
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly self: Command
  readonly stdin: Effect.Effect<string, RunnerError>
  readonly stdoutIsTerminal: boolean
}

const backlogRoot = (place: DispatchPlace): string => place.home + "/backlog"

type CliRequirements = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner

const failure = (error: BacklogError | ConfigError | TaskFileError | RunnerError): string =>
  error instanceof BacklogError || error instanceof RunnerError ? error.detail : error.file + ": " + error.detail

type ConfigReading = { readonly kind: "read"; readonly config: DispatchConfig } | { readonly kind: "unread"; readonly reason: string }

const readView = (root: string): Effect.Effect<BacklogView, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const paths = backlogPaths(root)
    const tasks = yield* listTasks(root)
    const reading = yield* readDispatchConfig(paths.dispatchConfig).pipe(
      Effect.map((config): ConfigReading => ({ kind: "read", config })),
      Effect.catchTag("ConfigError", (error) => Effect.succeed<ConfigReading>({ kind: "unread", reason: failure(error) }))
    )
    if (reading.kind === "unread") {
      return { tasks, projects: reading, room: reading }
    }
    const projects = yield* readProjects(paths.projects, reading.config.machines).pipe(
      Effect.map((list): ProjectList => ({ kind: "read", projects: list })),
      Effect.catchTag("ConfigError", (error) => Effect.succeed<ProjectList>({ kind: "unread", reason: failure(error) }))
    )
    const room: RoomList = { kind: "read", room: readRoom(reading.config.machines, tasks) }
    return { tasks, projects, room }
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

const add = (args: Extract<CommandArgs, { readonly kind: "AddTask" }>, place: DispatchPlace) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
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
    const taskPath = path.resolve(place.cwd, args.taskFile)
    const body = yield* fs.readFileString(taskPath).pipe(
      Effect.mapError((error) => new BacklogError({ detail: "cannot read the task file " + taskPath + ": " + error.message }))
    )
    const title = titleOf(body)
    if (title === "") {
      return yield* refuse("the task file " + taskPath + " holds no text")
    }
    const created = DateTime.formatIso(yield* DateTime.now)
    const record = yield* addTask(backlogRoot(place), { title, project: project.name, machine: args.machine, dependsOn: args.dependsOn, created, body })
    yield* Console.log("added " + record.spec.id + " for " + project.name + (args.machine === null ? "" : " on " + args.machine))
  })

const execute = (args: CommandArgs, place: DispatchPlace) =>
  Effect.gen(function*() {
    switch (args.kind) {
      case "ShowBacklog": {
        const view = yield* readView(backlogRoot(place))
        yield* Console.log(args.json ? JSON.stringify(backlogJson(view)) : formatBoard(view))
        break
      }
      case "AddTask": {
        yield* add(args, place)
        break
      }
      case "CloseTask": {
        const closedAt = DateTime.formatIso(yield* DateTime.now)
        yield* closeStartedTask(backlogRoot(place), args.id, args.outcome, args.reason, closedAt)
        yield* Console.log("closed " + args.id + " " + args.outcome)
        break
      }
      case "Beat": {
        const report = yield* runBeat(backlogRoot(place), place.home)
        yield* Console.log(args.json ? JSON.stringify(beatJson(report)) : formatBeat(report))
        break
      }
      case "RunnerStart": {
        const line = yield* startTask(place.env, place.stdin, args.reach, place.self, place.home)
        if (line !== null) {
          yield* Console.log(line)
        }
        break
      }
      case "RunnerRenew": {
        const line = yield* renewTask(place.stdin, args.reach, place.home)
        if (line !== null) {
          yield* Console.log(line)
        }
        break
      }
      case "RunnerHold": {
        yield* Console.log(yield* holdRun(args.task, args.run, place.home, args.label))
        break
      }
      case "RunnerToken": {
        yield* Console.log(yield* readSessionToken(args.session, place.stdoutIsTerminal))
        break
      }
      case "RunnerQueue": {
        yield* Console.log(yield* queueFromText(yield* place.stdin, place.self, place.home))
        break
      }
      case "RunnerResult": {
        const result = args.reach.kind === "here"
          ? yield* readResult(args.task, place.home, args.label)
          : yield* readResultThrough(args.reach.command, args.task, args.label)
        yield* Console.log(args.json ? JSON.stringify(runnerJson(result)) : formatResult(result))
        break
      }
    }
  })

export const runDispatch = (args: CommandArgs, place: DispatchPlace): Effect.Effect<void, string, CliRequirements> =>
  execute(args, place).pipe(Effect.mapError(failure))
