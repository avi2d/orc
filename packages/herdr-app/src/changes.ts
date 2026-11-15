import { type Guard, type Guarded, arrayOf, child, fields, number, ok, string } from "./guard"

type FileChange =
  | { readonly kind: "text"; readonly added: number; readonly deleted: number }
  | { readonly kind: "binary" }

export interface ChangedFile {
  readonly path: string
  readonly change: FileChange
}

export interface RunChanges {
  readonly worktree: string
  readonly base: string
  readonly branch: string
  readonly files: ReadonlyArray<ChangedFile>
}

export type DiffRow = {
  readonly kind: "hunk" | "added" | "deleted" | "context"
  readonly text: string
}

export const changesKey = "orc-changes.run"

const count = (text: string | undefined): number | null => text !== undefined && /^\d+$/.test(text) ? Number(text) : null

const numstatRecord = (record: string, at: string): Guarded<ChangedFile> => {
  const [added, deleted, ...rest] = record.split("\t")
  const path = rest.join("\t")
  if (path === "") return { kind: "refused", reason: `${at} is ${JSON.stringify(record)}, not added, deleted and a path` }
  if (added === "-" && deleted === "-") return ok({ path, change: { kind: "binary" } })
  const plus = count(added)
  const minus = count(deleted)
  if (plus === null || minus === null) return { kind: "refused", reason: `${at} is ${JSON.stringify(record)}, with no line counts` }
  return ok({ path, change: { kind: "text", added: plus, deleted: minus } })
}

export const changedFiles = (numstat: string): Guarded<ReadonlyArray<ChangedFile>> => {
  const files: Array<ChangedFile> = []
  for (const [index, record] of numstat.split("\0").filter((entry) => entry !== "").entries()) {
    const file = numstatRecord(record, `record ${(index + 1).toString()}`)
    if (file.kind === "refused") return file
    files.push(file.value)
  }
  return ok(files)
}

const rowKind = (line: string): DiffRow["kind"] =>
  line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "added" : line.startsWith("-") ? "deleted" : "context"

export const diffRows = (diff: string): ReadonlyArray<DiffRow> => {
  const lines = diff.replace(/\n$/, "").split("\n")
  const first = lines.findIndex((line) => line.startsWith("@@"))
  return first < 0 ? [] : lines.slice(first).map((text) => ({ kind: rowKind(text), text }))
}

export const changeTotals = (files: ReadonlyArray<ChangedFile>): { readonly added: number; readonly deleted: number } =>
  files.reduce((sum, file) => file.change.kind === "binary" ? sum : { added: sum.added + file.change.added, deleted: sum.deleted + file.change.deleted }, { added: 0, deleted: 0 })

const fileChange: Guard<FileChange> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const kind = string(record.value, "kind", at)
  if (kind.kind === "refused") return kind
  if (kind.value === "binary") return ok({ kind: "binary" })
  if (kind.value !== "text") return { kind: "refused", reason: `${child(at, "kind")} is ${JSON.stringify(kind.value)}, not "text" or "binary"` }
  const added = number(record.value, "added", at)
  if (added.kind === "refused") return added
  const deleted = number(record.value, "deleted", at)
  if (deleted.kind === "refused") return deleted
  return ok({ kind: "text", added: added.value, deleted: deleted.value })
}

const changedFile: Guard<ChangedFile> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const path = string(record.value, "path", at)
  if (path.kind === "refused") return path
  const change = fileChange(record.value["change"], child(at, "change"))
  return change.kind === "refused" ? change : ok({ path: path.value, change: change.value })
}

export const runChanges: Guard<RunChanges> = (value, at) => {
  const record = fields(value, at)
  if (record.kind === "refused") return record
  const worktree = string(record.value, "worktree", at)
  if (worktree.kind === "refused") return worktree
  const base = string(record.value, "base", at)
  if (base.kind === "refused") return base
  const branch = string(record.value, "branch", at)
  if (branch.kind === "refused") return branch
  const files = arrayOf(record.value, "files", at, changedFile)
  return files.kind === "refused" ? files : ok({ worktree: worktree.value, base: base.value, branch: branch.value, files: files.value })
}
