import { Effect, type FileSystem, Result, Schema } from "effect"
import { addTask, BacklogError } from "./backlog"
import type { SplitSource, TaskRecord, TaskSpec } from "./task-record"

export const splitDocumentSchema = "orc.split.v1"
export const childBudget = "about 300 changed lines or one area"

const Words = Schema.String.check(Schema.makeFilter((value) => value.trim() !== "")).annotate({ description: "A nonblank string." })

const Line = Schema.String.check(Schema.isPattern(/^[^\n]*\S[^\n]*$/)).annotate({ description: "A nonblank single-line title." })

const SplitChild = Schema.Struct({
  title: Line,
  body: Words.annotate({ description: "What the slice changes and how it is checked." }),
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
  reason: Words.annotate({ description: "Why the task exceeds the budget, as a nonblank string." }),
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

export const readPlanDocument = (text: string): Result.Result<PlanDocument, string> => {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end < start) {
    return Result.fail("printed no " + splitDocumentSchema + " document")
  }
  const decoded = decodePlan(text.slice(start, end + 1))
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

export const splitEventText = (applied: AppliedSplit, by: SplitSource, reason: string): string =>
  applied.parent.spec.id + " " + applied.parent.spec.title + " split at " + by + " into " +
  applied.children.map((child) => child.spec.id + " " + child.spec.title).join(", ") + ": " + reason
