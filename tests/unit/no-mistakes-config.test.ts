import { expect, test } from "bun:test"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path } from "effect"
import { readChecksCommands } from "../../packages/run/src/features/running-a-task/checks"

const provide = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, BunServices.layer))

test("the repository's .no-mistakes.yaml runs build and typecheck inside lint, not as separate commands", async () => {
  const text = await Bun.file(join(import.meta.dir, "../..", ".no-mistakes.yaml")).text()
  const commands = await provide(readChecksCommands(text, ".no-mistakes.yaml"))
  expect(commands.map((check) => check.name)).toEqual(["prepare", "lint"])
  const lint = commands.find((check) => check.name === "lint")
  expect(lint?.command).toContain("bun run build")
  expect(lint?.command).toContain("bun run typecheck")
})
