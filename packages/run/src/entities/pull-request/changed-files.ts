import { Effect, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { BacklogError } from "../backlog/index"
import type { RunnerError } from "../../shared/process/index"
import { gh, prPattern } from "./pr-view"

const ChangedFile = Schema.fromJsonString(Schema.Struct({
  status: Schema.String,
  path: Schema.String,
  version: Schema.Boolean
}))
export type ChangedFile = typeof ChangedFile.Type

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1)

const secretName = /^(\.env(\..*)?|.*secret.*|.*\.(pem|key|p12|pfx))$/i

const isRelease = (file: ChangedFile): boolean =>
  baseName(file.path) === "CHANGELOG.md" || (baseName(file.path) === "package.json" && file.version)

const waits = (what: string, files: ReadonlyArray<ChangedFile>): ReadonlyArray<string> =>
  files.length === 0 ? [] : [what + " " + files.map((file) => file.path).join(", ") + ", which waits for the captain's merge word"]

export const ownerWordChanges = (files: ReadonlyArray<ChangedFile>): ReadonlyArray<string> => [
  ...waits("is a release, as it changes", files.filter(isRelease)),
  ...waits("deletes", files.filter((file) => file.status === "removed")),
  ...waits("changes the workflow file", files.filter((file) => file.path.startsWith(".github/workflows/"))),
  ...waits("changes the secret file", files.filter((file) => secretName.test(baseName(file.path))))
]

const filesQuery = String.raw`.[] | {status, path: .filename, version: ((.patch // "") | test("(^|\n)[-+]\\s*\"version\"\\s*:"))}`

export const readChangedFiles = (url: string): Effect.Effect<ReadonlyArray<ChangedFile>, BacklogError | RunnerError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const [, host = "", owner = "", repo = ""] = prPattern.exec(url) ?? []
    const number = url.slice(url.lastIndexOf("/") + 1)
    const listed = yield* gh(["api", "--hostname", host, "--paginate", "repos/" + owner + "/" + repo + "/pulls/" + number + "/files", "--jq", filesQuery])
    if (listed.exitCode !== 0) {
      return yield* new BacklogError({ detail: "cannot read the files of " + url + ": " + listed.said })
    }
    const lines = listed.stdout.split("\n").filter((line) => line.trim() !== "")
    return yield* Effect.forEach(lines, (line) => Schema.decodeEffect(ChangedFile)(line)).pipe(
      Effect.mapError((error) => new BacklogError({ detail: "cannot read the files of " + url + ": gh printed no file list orc reads: " + error.message }))
    )
  })
