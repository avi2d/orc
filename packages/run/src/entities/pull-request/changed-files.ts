import { Effect, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { BacklogError } from "../backlog/index"
import type { RunnerError } from "../../shared/process/index"
import { gh, prPattern } from "./pr-view"

const RawFile = Schema.fromJsonString(Schema.Struct({
  status: Schema.String,
  path: Schema.String,
  previous: Schema.optional(Schema.NullOr(Schema.String)),
  patch: Schema.optional(Schema.NullOr(Schema.String)),
  version: Schema.optional(Schema.Boolean)
}))

const ChangedFile = Schema.Struct({
  status: Schema.String,
  path: Schema.String,
  previous: Schema.optional(Schema.String),
  version: Schema.Boolean
})
export type ChangedFile = typeof ChangedFile.Type

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1)

const secretName = /^(\.env(\..*)?|.*secret.*|.*\.(pem|key|p12|pfx))$/i

const pathsOf = (file: ChangedFile): ReadonlyArray<string> =>
  file.previous === undefined || file.previous === file.path ? [file.path] : [file.path, file.previous]

const displayOf = (file: ChangedFile): string =>
  file.previous === undefined || file.previous === file.path ? file.path : file.previous + "->" + file.path

const isRelease = (file: ChangedFile): boolean =>
  pathsOf(file).some((path) => baseName(path) === "CHANGELOG.md") || (file.version && pathsOf(file).some((path) => baseName(path) === "package.json"))

const waits = (what: string, files: ReadonlyArray<ChangedFile>): ReadonlyArray<string> =>
  files.length === 0 ? [] : [what + " " + files.map(displayOf).join(", ") + ", which waits for the captain's merge word"]

export const ownerWordChanges = (files: ReadonlyArray<ChangedFile>): ReadonlyArray<string> => [
  ...waits("is a release, as it changes", files.filter(isRelease)),
  ...waits("deletes", files.filter((file) => file.status === "removed")),
  ...waits("changes the workflow file", files.filter((file) => pathsOf(file).some((path) => path.startsWith(".github/workflows/")))),
  ...waits("changes the secret file", files.filter((file) => pathsOf(file).some((path) => secretName.test(baseName(path)))))
]

const versionPattern = /(^|\n)[-+]\s*"version"\s*:/

const filesQuery = String.raw`.[] | {status, path: .filename, previous: .previous_filename, patch: (.patch // null)}`

export const readChangedFiles = (url: string): Effect.Effect<ReadonlyArray<ChangedFile>, BacklogError | RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const [, host = "", owner = "", repo = ""] = prPattern.exec(url) ?? []
    const number = url.slice(url.lastIndexOf("/") + 1)
    const listed = yield* gh(["api", "--hostname", host, "--paginate", "repos/" + owner + "/" + repo + "/pulls/" + number + "/files", "--jq", filesQuery])
    if (listed.exitCode !== 0) {
      return yield* new BacklogError({ detail: "cannot read the files of " + url + ": " + listed.said })
    }
    const lines = listed.stdout.split("\n").filter((line) => line.trim() !== "")
    return yield* Effect.forEach(lines, (line) => Schema.decodeEffect(RawFile)(line).pipe(
      Effect.map((raw) => ({
        status: raw.status,
        path: raw.path,
        ...(raw.previous === undefined || raw.previous === null ? {} : { previous: raw.previous }),
        version: raw.version ?? (raw.patch === undefined || raw.patch === null ? true : versionPattern.test(raw.patch))
      } satisfies ChangedFile))
    )).pipe(
      Effect.mapError((error) => new BacklogError({ detail: "cannot read the files of " + url + ": gh printed no file list orc reads: " + error.message }))
    )
  })
