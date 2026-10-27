import { Effect, FileSystem, Path } from "effect"
import { BunServices } from "@effect/platform-bun"
const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const target = path.join(process.cwd(), "node_modules", "knip", "dist", "util", "jiti.js")
  const text = yield* fs.readFileString(target).pipe(Effect.orElseSucceed(() => null))
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
