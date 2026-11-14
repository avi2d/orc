import { Console, DateTime, Effect, FileSystem, Path } from "effect"
import { type TaskKind, type TaskPriority, addTask, backlogPaths, backlogRoot, BacklogError, listTasks, applySplit, splitEventText, type SplitRequest, type TaskFileError, type TaskRecord } from "../../entities/backlog/index"
import { refusedLinks } from "./backlog-depend"
import { checkoutOn, readDispatchConfig, readProjects, type ConfigError, readFailure } from "../../shared/config/index"
import { recordEvent } from "../../entities/events/index"
import { type IntakePlan, planIntake } from "./intake-plan"
import type { ChildProcessSpawner } from "effect/process"
import type { RunnerError } from "../../shared/process/index"

export type TaskSource = { readonly kind: "file"; readonly path: string } | { readonly kind: "stdin" }

export type AddTask = {
  readonly kind: "AddTask"
  readonly project: string
  readonly task: TaskSource
  readonly taskKind: TaskKind
  readonly internal: boolean
  readonly machine: string | null
  readonly parent: string | null
  readonly dependsOn: ReadonlyArray<string>
  readonly priority: TaskPriority | null
}

export interface AddPlace {
  readonly home: string
  readonly cwd: string
  readonly stdin: Effect.Effect<string, RunnerError>
  readonly stdinIsTerminal: boolean
}

const refuse = (detail: string) => Effect.fail(new BacklogError({ detail }))

export const titleOf = (body: string): string =>
  body.split("\n").map((line) => line.replace(/^#+\s*/, "").trim()).find((line) => line !== "") ?? ""

interface TaskText {
  readonly from: string
  readonly body: string
}

export const readTaskText = (source: TaskSource, place: AddPlace, command: string): Effect.Effect<TaskText, BacklogError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    if (source.kind === "stdin") {
      if (place.stdinIsTerminal) {
        return yield* refuse(command + " - reads the task from a pipe, and stdin is a terminal")
      }
      const body = yield* place.stdin.pipe(Effect.mapError((error) => new BacklogError({ detail: error.detail })))
      return { from: "the task on stdin", body } satisfies TaskText
    }
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const taskPath = path.resolve(place.cwd, source.path)
    const body = yield* fs.readFileString(taskPath).pipe(
      Effect.mapError((error) => new BacklogError({ detail: "cannot read the task file " + taskPath + ": " + readFailure(error) }))
    )
    return { from: "the task file " + taskPath, body } satisfies TaskText
  })

const addedLine = (record: TaskRecord): string =>
  "added " + record.spec.id + " for " + record.spec.project + (record.spec.machine === null ? "" : " on " + record.spec.machine) +
  (record.spec.kind === "ship" ? "" : " as a " + record.spec.kind) + (record.spec.internal ? " marked internal" : "") +
  (record.spec.parent === null ? "" : " as a child of " + record.spec.parent) +
  (record.spec.priority === null ? "" : " at P" + record.spec.priority) +
  (record.spec.split === null ? "" : ", split at " + record.spec.split.by + ": " + record.spec.split.reason)

const planNote = (plan: IntakePlan): string => {
  switch (plan.kind) {
    case "off": {
      return ""
    }
    case "planned": {
      return "\nplanned as one task: " + plan.plan.reason.trim()
    }
    case "unplanned": {
      return "\nnot planned, so it runs as one task: " + plan.reason
    }
  }
}

export const add = (
  args: AddTask,
  place: AddPlace
): Effect.Effect<void, BacklogError | ConfigError | TaskFileError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const root = backlogRoot(place.home)
    const paths = backlogPaths(root)
    const config = yield* readDispatchConfig(paths.dispatchConfig)
    const project = (yield* readProjects(paths.projects, config.machines)).find((candidate) => candidate.name === args.project)
    if (project === undefined) {
      return yield* refuse("the project " + args.project + " is not in " + paths.projects)
    }
    if (args.machine !== null && checkoutOn(project, args.machine) === null) {
      return yield* refuse("the project " + args.project + " has no checkout on " + args.machine + " in " + paths.projects)
    }
    const links = refusedLinks(args.parent, args.dependsOn, yield* listTasks(root))
    if (links !== null) {
      return yield* refuse(links)
    }
    const { from, body } = yield* readTaskText(args.task, place, "orc backlog add")
    const title = titleOf(body)
    if (title === "") {
      return yield* refuse(from + " holds no text")
    }
    const created = DateTime.formatIso(yield* DateTime.now)
    const request: SplitRequest = { title, project: project.name, internal: args.internal, machine: args.machine, dependsOn: args.dependsOn, priority: args.priority, created, body }
    const plan = args.taskKind === "ship" && args.parent === null ? yield* planIntake(place.home, body) : { kind: "off" } satisfies IntakePlan
    if (plan.kind === "planned" && plan.plan.plan === "split") {
      const applied = yield* applySplit(root, request, plan.plan, "intake")
      yield* recordEvent(root, { key: applied.parent.spec.id + ".split", at: created, text: splitEventText(applied, "intake", plan.plan.reason.trim()) })
      yield* Console.log([applied.parent, ...applied.children].map(addedLine).join("\n"))
      return
    }
    const record = yield* addTask(root, { ...request, kind: args.taskKind, parent: args.parent, split: null })
    yield* Console.log(addedLine(record) + planNote(plan))
  })
