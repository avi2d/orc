import { Console, Data, Effect, FileSystem, Path } from "effect"
import { BunServices } from "@effect/platform-bun"
import { workingTreeFiles } from "@avi2dg/checks/core/git.ts"
import { SOURCE_LIMITS } from "@avi2dg/checks/oxlint"
import { parse } from "vue/compiler-sfc"

const limit = SOURCE_LIMITS["max-lines"]

class CheckVueStylesError extends Data.TaggedError("CheckVueStylesError")<{
  readonly message: string
}> {}

export interface StyleBlock {
  readonly line: number
  readonly lines: number
}

const linesOf = (content: string): number => {
  const body = content.replace(/^\r?\n/, "")
  if (body === "") return 0
  const parts = body.split("\n")
  return body.endsWith("\n") ? parts.length - 1 : parts.length
}

export const styleBlocksOf = (source: string): Array<StyleBlock> =>
  parse(source).descriptor.styles.map((style) => ({ line: style.loc.start.line, lines: linesOf(style.content) }))

export const failuresOf = (file: string, source: string): Array<string> =>
  styleBlocksOf(source)
    .filter(({ lines }) => lines > limit)
    .map(({ line, lines }) =>
      file + ":" + line.toString() + ": style block of " + lines.toString() + " lines, over the " + limit.toString() + "-line budget; move it into a stylesheet file"
    )

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.join(import.meta.dir, "..")
  const listed = yield* workingTreeFiles(root).pipe(
    Effect.mapError((cause) => new CheckVueStylesError({ message: cause.message }))
  )
  const files = listed.filter((file) => file.endsWith(".vue")).toSorted()
  const failures = yield* Effect.forEach(files, (file) =>
    fs.readFileString(path.join(root, file)).pipe(
      Effect.mapError((cause) => new CheckVueStylesError({ message: "cannot read " + file + ": " + String(cause) })),
      Effect.map((source) => failuresOf(file, source))
    ))
  if (failures.flat().length > 0) {
    yield* Console.error(failures.flat().join("\n"))
    yield* Effect.sync(() => {
      process.exitCode = 1
    })
  } else {
    yield* Console.log("Checked style blocks in " + files.length.toString() + " Vue files")
  }
}).pipe(Effect.provide(BunServices.layer))

if (import.meta.main) void Effect.runPromise(program)
