import { Console, Data, Effect, FileSystem, Path } from "effect"
import { BunServices } from "@effect/platform-bun"

class DocPagesError extends Data.TaggedError("DocPagesError")<{
  readonly message: string
}> {}

export interface DocPageCheck {
  readonly skipsDirectory: (name: string) => boolean
  readonly checksPage: (page: string) => boolean
  readonly failuresOf: (page: string, source: string) => ReadonlyArray<string>
  readonly passed: (pages: number) => string
}

const listedOf = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  skipsDirectory: DocPageCheck["skipsDirectory"],
  target: string
): Effect.Effect<Array<string>, DocPagesError> =>
  fs.stat(target).pipe(
    Effect.mapError((cause) => new DocPagesError({ message: "cannot stat " + target + ": " + String(cause) })),
    Effect.flatMap((info) => {
      if (info.type === "Directory") {
        return skipsDirectory(path.basename(target)) ? Effect.succeed([]) : markdownFiles(fs, path, skipsDirectory, target)
      }
      return Effect.succeed(info.type === "File" && target.endsWith(".md") ? [target] : [])
    })
  )
const markdownFiles = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  skipsDirectory: DocPageCheck["skipsDirectory"],
  directory: string
): Effect.Effect<Array<string>, DocPagesError> =>
  fs.readDirectory(directory).pipe(
    Effect.mapError((cause) => new DocPagesError({ message: "cannot list " + directory + ": " + String(cause) })),
    Effect.flatMap((entries) =>
      Effect.forEach(entries, (entry) => listedOf(fs, path, skipsDirectory, path.join(directory, entry)))
    ),
    Effect.map((groups) => groups.flat())
  )

export const checkDocPages = (check: DocPageCheck): Effect.Effect<void, DocPagesError> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const docs = path.join(import.meta.dir, "..", "docs")
    const files = yield* markdownFiles(fs, path, check.skipsDirectory, docs)
    if (files.length === 0) {
      return yield* new DocPagesError({ message: "No documentation pages found" })
    }
    const wanted = files.filter((file) => check.checksPage(path.relative(docs, file)))
    const pages = yield* Effect.forEach(wanted, (file) =>
      fs.readFileString(file).pipe(
        Effect.mapError((cause) => new DocPagesError({ message: "cannot read " + file + ": " + String(cause) })),
        Effect.map((source) => check.failuresOf(path.relative(docs, file), source))
      ))
    const failures = pages.flat()
    if (failures.length > 0) {
      yield* Console.error(failures.join("\n"))
      yield* Effect.sync(() => {
        process.exitCode = 1
      })
    } else {
      yield* Console.log(check.passed(files.length))
    }
  }).pipe(Effect.provide(BunServices.layer))
