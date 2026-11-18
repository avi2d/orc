import { Console, Data, Effect, FileSystem, Path } from "effect"
import { BunServices } from "@effect/platform-bun"

const limit = 300
const exempt = new Set(["index.md", "map/index.md"])
const headingPattern = /^#{1,6}\s+\S.*$/

class CheckDocSectionsError extends Data.TaggedError("CheckDocSectionsError")<{
  readonly message: string
}> {}

const listedOf = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  target: string
): Effect.Effect<Array<string>, CheckDocSectionsError> =>
  fs.stat(target).pipe(
    Effect.mapError((cause) => new CheckDocSectionsError({ message: "cannot stat " + target + ": " + String(cause) })),
    Effect.flatMap((info) => {
      if (info.type === "Directory") {
        const base = path.basename(target)
        return base === "adr" || base.startsWith(".") ? Effect.succeed([]) : markdownFiles(fs, path, target)
      }
      return Effect.succeed(info.type === "File" && target.endsWith(".md") ? [target] : [])
    })
  )
const markdownFiles = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string
): Effect.Effect<Array<string>, CheckDocSectionsError> =>
  fs.readDirectory(directory).pipe(
    Effect.mapError((cause) => new CheckDocSectionsError({ message: "cannot list " + directory + ": " + String(cause) })),
    Effect.flatMap((names) => Effect.forEach(names, (name) => listedOf(fs, path, path.join(directory, name)))),
    Effect.map((groups) => groups.flat())
  )
const wordsOf = (value: string): number => {
  const tokens = value.trim().split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token))
  return value.trim() === "" ? 0 : tokens.length
}
const overLimit = (failures: Array<string>, name: string, heading: string, body: string): void => {
  const count = wordsOf(body)
  if (count > limit) failures.push(name + ": " + count.toString() + " words after \"" + heading + "\" (limit " + limit.toString() + ")")
}
const failuresOf = (name: string, source: string): Array<string> => {
  const withoutFrontmatter = source.replace(/^---\n[\s\S]*?\n---\n/, "")
  const prose = withoutFrontmatter.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "")
  const lines = prose.split("\n")
  if (!lines.some((line) => headingPattern.test(line))) {
    const total = wordsOf(prose)
    return total > limit ? [name + ": " + total.toString() + " words with no heading (limit " + limit.toString() + ")"] : []
  }
  const failures: Array<string> = []
  let current: string | undefined
  let body: Array<string> = []
  for (const line of lines) {
    if (headingPattern.test(line)) {
      if (current !== undefined) overLimit(failures, name, current, body.join("\n"))
      current = line
      body = []
    } else if (current !== undefined) {
      body.push(line)
    }
  }
  if (current !== undefined) overLimit(failures, name, current, body.join("\n"))
  return failures
}
const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const docs = path.join(import.meta.dir, "..", "docs")
  const files = yield* markdownFiles(fs, path, docs)
  if (files.length === 0) {
    return yield* new CheckDocSectionsError({ message: "No documentation pages found" })
  }
  const wanted = files.filter((file) => !exempt.has(path.relative(docs, file)))
  const sections = yield* Effect.forEach(wanted, (file) =>
    fs.readFileString(file).pipe(
      Effect.mapError((cause) => new CheckDocSectionsError({ message: "cannot read " + file + ": " + String(cause) })),
      Effect.map((source) => failuresOf(path.relative(docs, file), source))
    ))
  const failures = sections.flat()
  if (failures.length > 0) {
    yield* Console.error(failures.join("\n"))
    yield* Effect.sync(() => {
      process.exitCode = 1
    })
  } else {
    yield* Console.log("Checked section lengths in " + files.length.toString() + " documentation pages")
  }
}).pipe(Effect.provide(BunServices.layer))

void Effect.runPromise(program)
