import { Console, Data, Effect, FileSystem, Path } from "effect"
import { BunServices } from "@effect/platform-bun"
import tools from "./outside-tools.json"

export interface OutsideTool {
  readonly name: string
  readonly url: string
}

class CheckDocLinksError extends Data.TaggedError("CheckDocLinksError")<{
  readonly message: string
}> {}

const fencePattern = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm
const targetPatterns = [/\]\(\s*<?([^)\s>]+)/g, /^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm, /<(https?:\/\/[^>\s]+)>/g, /href="([^"]+)"/g]
const proseCuts = [/`+[^`\n]*`+/g, /!?\[[^\]]*\]\([^)]*\)/g, /!?\[[^\]]*\]\[[^\]]*\]/g, /^\s*\[[^\]]+\]:.*$/gm, /<[^>\n]*>/g, /https?:\/\/\S+/g]

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const bare = (url: string): string => url.replace(/[#?].*$/, "").replace(/\/+$/, "")
const pageOf = (source: string): string => source.replace(/^---\n[\s\S]*?\n---\n/, "").replace(fencePattern, "")
const targetsOf = (page: string): Set<string> =>
  new Set(targetPatterns.flatMap((pattern) => [...page.matchAll(pattern)].map((match) => bare(match[1]))))
const proseOf = (page: string): string => proseCuts.reduce((text, cut) => text.replace(cut, " "), page)
const names = (prose: string, tool: OutsideTool): boolean =>
  new RegExp("(?<![\\p{L}\\p{N}_./-])" + escaped(tool.name) + "(?![\\p{L}\\p{N}_-])", "iu").test(prose)

export const unlinkedTools = (source: string, registry: ReadonlyArray<OutsideTool>): Array<OutsideTool> => {
  const page = pageOf(source)
  const targets = targetsOf(page)
  const prose = proseOf(page)
  return registry.filter((tool) => names(prose, tool) && !targets.has(bare(tool.url)))
}

const listedOf = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  target: string
): Effect.Effect<Array<string>, CheckDocLinksError> =>
  fs.stat(target).pipe(
    Effect.mapError((cause) => new CheckDocLinksError({ message: "cannot stat " + target + ": " + String(cause) })),
    Effect.flatMap((info) => {
      if (info.type === "Directory") {
        return path.basename(target).startsWith(".") ? Effect.succeed([]) : markdownFiles(fs, path, target)
      }
      return Effect.succeed(info.type === "File" && target.endsWith(".md") ? [target] : [])
    })
  )
const markdownFiles = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string
): Effect.Effect<Array<string>, CheckDocLinksError> =>
  fs.readDirectory(directory).pipe(
    Effect.mapError((cause) => new CheckDocLinksError({ message: "cannot list " + directory + ": " + String(cause) })),
    Effect.flatMap((entries) => Effect.forEach(entries, (entry) => listedOf(fs, path, path.join(directory, entry)))),
    Effect.map((groups) => groups.flat())
  )
const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const docs = path.join(import.meta.dir, "..", "docs")
  const files = yield* markdownFiles(fs, path, docs)
  if (files.length === 0) {
    return yield* new CheckDocLinksError({ message: "No documentation pages found" })
  }
  const pages = yield* Effect.forEach(files, (file) =>
    fs.readFileString(file).pipe(
      Effect.mapError((cause) => new CheckDocLinksError({ message: "cannot read " + file + ": " + String(cause) })),
      Effect.map((source) =>
        unlinkedTools(source, tools).map((tool) =>
          path.relative(docs, file) + ": names " + tool.name + " but never links " + tool.url
        )
      )
    ))
  const failures = pages.flat()
  if (failures.length > 0) {
    yield* Console.error(failures.join("\n"))
    yield* Effect.sync(() => {
      process.exitCode = 1
    })
  } else {
    yield* Console.log("Checked outside tool links in " + files.length.toString() + " documentation pages")
  }
}).pipe(Effect.provide(BunServices.layer))

if (import.meta.main) void Effect.runPromise(program)
