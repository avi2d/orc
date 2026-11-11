import { Effect, type FileSystem, Result, Schema } from "effect"
import { addTask, BacklogError, closeStartedTask, findTask, listTasks, reopenStartedTask, type Rewrite, rewriteNew } from "./backlog"
import type { SplitSource, TaskFileError, TaskRecord, TaskSpec } from "./task-record"

export const splitDocumentSchema = "orc.split.v1"
export const childBudget = "about 300 changed lines or one area"

const Words = Schema.String.check(Schema.makeFilter((value) => value.trim() !== ""))

const Line = Schema.String.check(Schema.isPattern(/^[^\n]*\S[^\n]*$/)).annotate({ description: "A nonblank single-line title." })

const SplitChild = Schema.Struct({
  title: Line,
  body: Words,
  after: Schema.Array(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({ description: "Numbers of earlier children needed, starting at 1. Use an empty array for an independent child." })
})

const WholeDocument = Schema.Struct({
  schema: Schema.Literal(splitDocumentSchema),
  plan: Schema.Literal("whole"),
  reason: Words
})

export const SplitDocument = Schema.Struct({
  schema: Schema.Literal(splitDocumentSchema),
  plan: Schema.Literal("split"),
  reason: Words,
  done: Schema.Array(Words).check(Schema.isMinLength(1)).annotate({ description: "Done criteria for the whole task, each a nonblank string." }),
  children: Schema.Array(SplitChild).check(Schema.isMinLength(2)).annotate({ description: "Vertical slices that merge to main independently." })
})

const PlanDocument = Schema.Union([WholeDocument, SplitDocument])
export const splitJsonSchema = JSON.stringify(Schema.toJsonSchemaDocument(SplitDocument).schema)
export type PlanDocument = typeof PlanDocument.Type
export type SplitPlan = typeof SplitDocument.Type
export const splitReasonPrefix = "split proposal: "

const decodePlan = Schema.decodeUnknownResult(Schema.fromJsonString(PlanDocument))

const laterWait = (plan: SplitPlan): string | null => {
  for (const [index, child] of plan.children.entries()) {
    const later = child.after.find((number) => number > index)
    if (later !== undefined) {
      return "child " + (index + 1) + " waits on child " + later + ", and a child waits only on a child before it"
    }
  }
  return null
}

const balancedDocument = (text: string): string | null => {
  const start = text.indexOf("{")
  if (start === -1) {
    return null
  }
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === "\"") {
        inString = false
      }
    } else if (char === "\"") {
      inString = true
    } else if (char === "{") {
      depth += 1
    } else if (char === "}") {
      depth -= 1
      if (depth === 0) {
        return text.slice(start, index + 1)
      }
    }
  }
  return null
}

export const readPlanDocument = (text: string): Result.Result<PlanDocument, string> => {
  const document = balancedDocument(text)
  if (document === null) {
    return Result.fail("printed no " + splitDocumentSchema + " document")
  }
  const decoded = decodePlan(document)
  if (Result.isFailure(decoded)) {
    return Result.fail("printed no " + splitDocumentSchema + " document: " + decoded.failure.message)
  }
  const wait = decoded.success.plan === "split" ? laterWait(decoded.success) : null
  return wait === null ? Result.succeed(decoded.success) : Result.fail("printed a split where " + wait)
}

export type SplitRequest = Pick<TaskSpec, "title" | "project" | "internal" | "machine" | "dependsOn" | "created" | "body">

export interface AppliedSplit {
  readonly parent: TaskRecord
  readonly children: ReadonlyArray<TaskRecord>
}

const parentBody = (request: SplitRequest, done: ReadonlyArray<string>): string =>
  request.body.trimEnd() + "\n\n## Done when\n\n" + done.map((criterion) => "- " + criterion.trim()).join("\n") + "\n"

const childBody = (child: SplitPlan["children"][number], parent: TaskRecord): string =>
  "# " + child.title.trim() + "\n\n" + child.body.trim() + "\n\nThis is one slice of " + parent.spec.id + ", " + parent.spec.title +
  ", and it merges to main on its own.\n"

const addChildren = (
  root: string,
  request: SplitRequest,
  parent: TaskRecord,
  plan: SplitPlan
): Effect.Effect<AppliedSplit, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const children: Array<TaskRecord> = []
    for (const child of plan.children) {
      const after = [...new Set(child.after)].flatMap((number) => children[number - 1]?.spec.id ?? [])
      children.push(yield* addTask(root, {
        ...request,
        title: child.title.trim(),
        kind: "ship",
        parent: parent.spec.id,
        split: null,
        dependsOn: [...request.dependsOn, ...after],
        body: childBody(child, parent)
      }))
    }
    return { parent, children }
  })

export const applySplit = (
  root: string,
  request: SplitRequest,
  plan: SplitPlan,
  by: SplitSource
): Effect.Effect<AppliedSplit, BacklogError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const parent = yield* addTask(root, {
      ...request,
      kind: "parent",
      internal: false,
      parent: null,
      split: { by, reason: plan.reason.trim() },
      body: parentBody(request, plan.done)
    })
    return yield* addChildren(root, request, parent, plan)
  })

const handOverDependents = (
  root: string,
  from: string,
  to: ReadonlyArray<string>
): Effect.Effect<void, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const handedOver = (fresh: TaskRecord): Effect.Effect<Rewrite<void>, BacklogError> =>
      Effect.succeed(fresh.spec.dependsOn.includes(from)
        ? { kind: "write", record: { ...fresh, spec: { ...fresh.spec, dependsOn: fresh.spec.dependsOn.flatMap((id) => id === from ? to : [id]) } }, result: undefined }
        : { kind: "keep", result: undefined })
    for (const dependent of yield* listTasks(root)) {
      if (dependent.state.kind === "new" && dependent.spec.dependsOn.includes(from)) {
        yield* rewriteNew(root, dependent.spec.id, handedOver)
      }
    }
  })

export const applyRunSplit = (
  root: string,
  task: TaskRecord,
  plan: SplitPlan,
  created: string
): Effect.Effect<AppliedSplit, BacklogError | TaskFileError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const { title, project, internal, machine, dependsOn, body, parent } = task.spec
    if (parent !== null) {
      const grandparent = yield* findTask(root, parent)
      const siblings = yield* addChildren(root, { title, project, internal, machine, dependsOn, created, body }, grandparent, plan)
      // A proposer closed done with no PR frees its dependents, so they must wait on the slices before it closes.
      yield* handOverDependents(root, task.spec.id, siblings.children.map((child) => child.spec.id))
      const closed = yield* closeStartedTask(
        root,
        task.spec.id,
        "done",
        "split into " + siblings.children.map((child) => child.spec.id).join(", ") + ": " + plan.reason.trim(),
        { pr: null, report: null },
        created,
        (spec) => ({ ...spec, parent: null })
      )
      return { parent: closed, children: siblings.children }
    }
    const reopened = yield* reopenStartedTask(root, task.spec.id, (spec) => ({
      ...spec,
      kind: "parent",
      internal: false,
      split: { by: "run", reason: plan.reason.trim() },
      body: parentBody(spec, plan.done)
    }))
    return yield* addChildren(root, { title, project, internal, machine, dependsOn, created, body }, reopened, plan)
  })

export const splitEventText = (applied: AppliedSplit, by: SplitSource, reason: string): string =>
  applied.parent.spec.id + " " + applied.parent.spec.title + " split at " + by + " into " +
  applied.children.map((child) => child.spec.id + " " + child.spec.title).join(", ") + ": " + reason
