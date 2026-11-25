import { DateTime, Effect, type FileSystem, type Path } from "effect"
import type { DispatchArgs } from "./dispatch-args"
import { BacklogError, backlogRoot, closeStartedTask, findTask, type TaskFileError } from "../entities/backlog/index"
import { withdrawTaskItems } from "../entities/attention/index"
import { closeLandedTask, dropTask } from "../features/backlog-planning/index"

type CommandArgs = Exclude<DispatchArgs, { readonly kind: "UsageError" }>

const closeDecision = (args: Extract<CommandArgs, { readonly kind: "CloseTask" }>, root: string, at: string): Effect.Effect<string, BacklogError | TaskFileError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    if (args.outcome === "done") {
      return yield* new BacklogError({ detail: args.id + " is a decision, so it closes done only by its answer: orc backlog answer " + args.id + " <words>" })
    }
    const reason = args.reason.trim() === "" ? "the captain dropped the decision" : args.reason
    yield* dropTask(root, args.id, reason, at)
    return "dropped " + args.id + ": " + reason
  })

export const closeNow = (args: Extract<CommandArgs, { readonly kind: "CloseTask" }>, home: string): Effect.Effect<string, BacklogError | TaskFileError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const root = backlogRoot(home)
    const at = DateTime.formatIso(yield* DateTime.now)
    if ((yield* findTask(root, args.id)).spec.kind === "decision") {
      return yield* closeDecision(args, root, at)
    }
    yield* closeStartedTask(root, args.id, args.outcome, args.reason, { pr: null, report: null }, at)
    yield* withdrawTaskItems(root, [args.id], at)
    return "closed " + args.id + " " + args.outcome
  })

export const closeLandedNow = (args: Extract<CommandArgs, { readonly kind: "CloseLandedTask" }>, home: string): Effect.Effect<string, BacklogError | TaskFileError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const root = backlogRoot(home)
    const at = DateTime.formatIso(yield* DateTime.now)
    const reason = yield* closeLandedTask(root, args.id, args.pr, at)
    return "closed " + args.id + " done: " + reason
  })

export const dropNow = (args: Extract<CommandArgs, { readonly kind: "DropTask" }>, home: string): Effect.Effect<string, BacklogError | TaskFileError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const root = backlogRoot(home)
    const at = DateTime.formatIso(yield* DateTime.now)
    yield* dropTask(root, args.id, args.reason, at)
    return "dropped " + args.id + ": " + args.reason
  })
