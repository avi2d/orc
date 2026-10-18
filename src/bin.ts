#!/usr/bin/env bun
import { runMain } from "@effect/platform-bun/BunRuntime"
import { BunServices } from "@effect/platform-bun"
import { Console, Effect } from "effect"
import packageJson from "../package.json" with { type: "json" }
import { parseArgs } from "./args"
import {
  formatRunsTable,
  type HistoryError,
  listRuns,
  openDatabase,
  orcHomeDir,
  runsJson,
  SqliteFailure,
  UnsupportedSchemaVersion
} from "./run-history"

const usage = "Usage: orc [--version] [--help] | orc runs [--json]"

const historyErrorMessage = (error: HistoryError): string => {
  if (error instanceof UnsupportedSchemaVersion) {
    return `unsupported schema version ${error.found}, expected ${error.expected}`
  }
  if (error instanceof SqliteFailure) {
    return error.cause instanceof Error ? error.cause.message : String(error.cause)
  }
  return String(error)
}

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
      const text = yield* Effect.acquireUseRelease(
        openDatabase(orcHomeDir()),
        (db) => listRuns(db),
        (db) => Effect.sync(() => db.close())
      ).pipe(
        Effect.map((runs) => args.json ? JSON.stringify(runsJson(runs)) : formatRunsTable(runs)),
        Effect.provide(BunServices.layer),
        Effect.catch((error) =>
          Console.error(`orc: cannot read the run history: ${historyErrorMessage(error)}`).pipe(
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
