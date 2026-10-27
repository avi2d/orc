import { Data, Effect, Schema } from "effect"

export const taskFolders = ["new", "taken", "closed"] as const
export type TaskFolder = typeof taskFolders[number]

export interface TaskSpec {
  readonly id: string
  readonly title: string
  readonly project: string
  readonly machine: string | null
  readonly dependsOn: ReadonlyArray<string>
  readonly created: string
  readonly body: string
}

export interface Claim {
  readonly beat: string
  readonly machine: string
  readonly account: string
  readonly takenAt: string
}

export interface Started {
  readonly at: string
  readonly note: string
}

type Closing =
  | { readonly outcome: "start-failed"; readonly reason: string }
  | { readonly outcome: "done" | "failed"; readonly started: Started; readonly reason: string }

type TaskState =
  | { readonly kind: "new" }
  | { readonly kind: "taken"; readonly claim: Claim | null }
  | { readonly kind: "started"; readonly claim: Claim; readonly started: Started }
  | { readonly kind: "closed"; readonly claim: Claim; readonly closing: Closing; readonly closedAt: string }

export interface TaskRecord {
  readonly spec: TaskSpec
  readonly state: TaskState
}

export class TaskFileError extends Data.TaggedError("TaskFileError")<{
  readonly file: string
  readonly detail: string
}> {}

const Frontmatter = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  project: Schema.String,
  machine: Schema.NullOr(Schema.String),
  depends_on: Schema.Array(Schema.String),
  created: Schema.String,
  beat: Schema.optional(Schema.String),
  taken_for: Schema.optional(Schema.String),
  account: Schema.optional(Schema.String),
  taken_at: Schema.optional(Schema.String),
  started_at: Schema.optional(Schema.String),
  start_note: Schema.optional(Schema.String),
  outcome: Schema.optional(Schema.Literals(["done", "failed", "start-failed"])),
  closed_at: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String)
})
type Frontmatter = typeof Frontmatter.Type

const fence = "---"

const claimOf = (front: Frontmatter): Claim | null =>
  front.beat === undefined || front.taken_for === undefined || front.account === undefined || front.taken_at === undefined
    ? null
    : { beat: front.beat, machine: front.taken_for, account: front.account, takenAt: front.taken_at }

const startedOf = (front: Frontmatter): Started | null =>
  front.started_at === undefined ? null : { at: front.started_at, note: front.start_note ?? "" }

const closingOf = (front: Frontmatter, started: Started | null): Closing | null => {
  const reason = front.reason ?? ""
  if (front.outcome === "start-failed") {
    return { outcome: "start-failed", reason }
  }
  return front.outcome === undefined || started === null ? null : { outcome: front.outcome, started, reason }
}

const stateOf = (folder: TaskFolder, front: Frontmatter): TaskState | string => {
  if (folder === "new") {
    return { kind: "new" }
  }
  const claim = claimOf(front)
  const started = startedOf(front)
  if (folder === "taken") {
    if (started === null) {
      return { kind: "taken", claim }
    }
    return claim === null ? "a started task names no claim" : { kind: "started", claim, started }
  }
  const closing = closingOf(front, started)
  if (claim === null || closing === null || front.closed_at === undefined) {
    return "a closed task names no claim, outcome or close time"
  }
  return { kind: "closed", claim, closing, closedAt: front.closed_at }
}

const splitFrontmatter = (text: string): { readonly head: string; readonly body: string } | null => {
  if (!text.startsWith(fence + "\n")) {
    return null
  }
  const end = text.indexOf("\n" + fence + "\n", fence.length)
  if (end === -1) {
    return null
  }
  return { head: text.slice(fence.length + 1, end + 1), body: text.slice(end + fence.length + 2) }
}

export const parseTaskFile = (file: string, folder: TaskFolder, text: string): Effect.Effect<TaskRecord, TaskFileError> =>
  Effect.gen(function*() {
    const parts = splitFrontmatter(text)
    if (parts === null) {
      return yield* new TaskFileError({ file, detail: "the task file opens with no --- frontmatter" })
    }
    const raw: unknown = yield* Effect.try({
      try: () => Bun.YAML.parse(parts.head),
      catch: () => new TaskFileError({ file, detail: "the frontmatter is no YAML orc can read" })
    })
    const front = yield* Schema.decodeUnknownEffect(Frontmatter)(raw).pipe(
      Effect.mapError((error) => new TaskFileError({ file, detail: error.message }))
    )
    const stem = file.split("/").at(-1)?.replace(/\.md$/, "")
    if (front.id !== stem) {
      return yield* new TaskFileError({ file, detail: "the frontmatter id " + front.id + " is not the file " + (stem ?? file) })
    }
    const state = stateOf(folder, front)
    if (typeof state === "string") {
      return yield* new TaskFileError({ file, detail: state })
    }
    return {
      spec: {
        id: front.id,
        title: front.title,
        project: front.project,
        machine: front.machine,
        dependsOn: front.depends_on,
        created: front.created,
        body: parts.body
      },
      state
    }
  })

const field = (key: string, value: unknown): string => key + ": " + JSON.stringify(value)

const claimFields = (claim: Claim | null): ReadonlyArray<string> =>
  claim === null
    ? []
    : [field("beat", claim.beat), field("taken_for", claim.machine), field("account", claim.account), field("taken_at", claim.takenAt)]

const startedFields = (started: Started): ReadonlyArray<string> => [field("started_at", started.at), field("start_note", started.note)]

const stateFields = (state: TaskState): ReadonlyArray<string> => {
  switch (state.kind) {
    case "new": {
      return []
    }
    case "taken": {
      return claimFields(state.claim)
    }
    case "started": {
      return [...claimFields(state.claim), ...startedFields(state.started)]
    }
    case "closed": {
      const started = state.closing.outcome === "start-failed" ? [] : startedFields(state.closing.started)
      return [
        ...claimFields(state.claim),
        ...started,
        field("outcome", state.closing.outcome),
        field("closed_at", state.closedAt),
        field("reason", state.closing.reason)
      ]
    }
  }
}

export const renderTaskFile = (record: TaskRecord): string =>
  [
    fence,
    field("id", record.spec.id),
    field("title", record.spec.title),
    field("project", record.spec.project),
    field("machine", record.spec.machine),
    field("depends_on", record.spec.dependsOn),
    field("created", record.spec.created),
    ...stateFields(record.state),
    fence,
    record.spec.body
  ].join("\n")
