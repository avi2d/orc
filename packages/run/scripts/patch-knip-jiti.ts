import { Effect, FileSystem, Path } from "effect"
import { BunServices } from "@effect/platform-bun"
const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const kit = yield* fs.realPath(path.join(process.cwd(), "node_modules", "@avi2dg", "checks")).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(null)))
  if (kit === null) {
    return
  }
  const main = yield* Effect.try(() => import.meta.resolve("knip", path.join(kit, "package.json"))).pipe(
    Effect.flatMap((url) => path.fromFileUrl(new URL(url))),
    Effect.catchTag(["BadArgument", "UnknownError"], () => Effect.succeed(null)),
  )
  if (main === null) {
    return
  }
  const target = path.join(path.dirname(main), "util", "jiti.js")
  const text = yield* fs.readFileString(target).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(null)))
  if (text === null) {
    return
  }
  const from = "tsconfigPaths: true"
  if (!text.includes(from)) {
    return
  }
  const to = "tsconfigPaths: process.cwd() + \"/tsconfig.json\""
  yield* fs.writeFileString(target, text.replace(from, to))
}).pipe(Effect.provide(BunServices.layer))
void Effect.runPromise(program)
