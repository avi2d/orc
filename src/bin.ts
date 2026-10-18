#!/usr/bin/env bun
import { runMain } from "@effect/platform-bun/BunRuntime"
import { BunServices } from "@effect/platform-bun"
import { Console, Effect } from "effect"
import packageJson from "../package.json" with { type: "json" }
import { parseArgs } from "./args"
import {
  formatRunsTable,
  listRuns,
  openDatabase,
  resolveHomeDir,
  runsJson,
  UnsupportedSchemaVersion
} from "./run-history"

const usage = "Usage: orc [--version] [--help] | orc runs [--json]"

const unsupportedVersionMessage = (cause: UnsupportedSchemaVersion): string =>
  `unsupported schema version ${cause.found}, expected ${cause.expected}`

const program = Effect.gen(function*() {
  const args = parseArgs(Bun.argv.slice(2))
  switch (args.kind) {
    case "PrintVersion": {
      yield* Console.log(`orc ${packageJson.version}`)
      break
    }
    case "PrintHelp": {
      yield* Console.log(usage)
      break
    }
    case "ListRuns": {
      const text = yield* Effect.gen(function*() {
        const db = yield* openDatabase(resolveHomeDir(Bun.env.ORC_HOME))
        const runs = yield* listRuns(db)
        db.close()
        return args.json ? JSON.stringify(runsJson(runs)) : formatRunsTable(runs)
      }).pipe(
        Effect.provide(BunServices.layer),
        Effect.catchTag("UnsupportedSchemaVersion", (cause) =>
          Console.error(`orc: cannot read the run history: ${unsupportedVersionMessage(cause)}`).pipe(
            Effect.andThen(Effect.fail("run history unavailable"))
          )
        ),
        Effect.catch((cause) =>
          Console.error(`orc: cannot read the run history: ${String(cause)}`).pipe(
            Effect.andThen(Effect.fail("run history unavailable"))
          )
        )
      )
      yield* Console.log(text)
      break
    }
    case "UsageError": {
      yield* Console.error(`${args.detail}\n${usage}`)
      return yield* Effect.fail(args.detail)
    }
  }
})

runMain(program, { disableErrorReporting: true })
