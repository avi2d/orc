#!/usr/bin/env bun
import type { Database } from "bun:sqlite"
import { runMain } from "@effect/platform-bun/BunRuntime"
import { BunServices } from "@effect/platform-bun"
import { Console, Effect } from "effect"
import packageJson from "../package.json" with { type: "json" }
import { parseArgs } from "./args"
import { runAgentStep } from "./run"
import { formatReport } from "./run-record"
import { encodeRunsJson, formatHistoryError, formatRunsTable, listRuns, openDatabase, orcHomeDir } from "./run-history"
import { encodeShowJson, formatShow, readShow } from "./show"

const usage = "Usage: orc [--version] [--help] | orc runs [--json] | orc show <run> [--json] | orc run [<task-file>] [--branch <name>] [--allow ask-user] [--allow question]"

const readFailure = (error: unknown): string =>
  typeof error === "string" ? error : "orc: cannot read the run history: " + formatHistoryError(error)

const readHistory = <A, E>(use: (db: Database) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    openDatabase(orcHomeDir()),
    use,
    (db) => Effect.sync(() => db.close())
  ).pipe(
    Effect.provide(BunServices.layer),
    Effect.catch((error) =>
      Console.error(readFailure(error)).pipe(Effect.andThen(Effect.fail("run history unavailable")))
    )
  )

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
      const runs = yield* readHistory((db) => listRuns(db))
      if (args.json) {
        yield* Console.log(yield* encodeRunsJson(runs))
      } else {
        yield* Console.log(formatRunsTable(runs))
      }
      break
    }
    case "ShowRun": {
      const document = yield* readHistory((db) => readShow(db, args.id))
      if (document === null) {
        yield* Console.error("orc: unknown run " + args.id)
        return yield* Effect.fail("run history unavailable")
      }
      if (args.json) {
        yield* Console.log(yield* encodeShowJson(document))
      } else {
        yield* Console.log(formatShow(document))
      }
      break
    }
    case "RunAgent": {
      const report = yield* runAgentStep({ cwd: process.cwd(), taskFile: args.taskFile, branch: args.branch, allow: args.allow }).pipe(
        Effect.provide(BunServices.layer),
        Effect.catchTag("OrcRunError", (error) =>
          Console.error(error.message).pipe(Effect.andThen(Effect.fail("agent step refused")))
        )
      )
      yield* Console.log(formatReport(report))
      if (!report.completed) {
        return yield* Effect.fail("agent step failed")
      }
      break
    }
    case "UsageError": {
      yield* Console.error(`${args.detail}\n${usage}`)
      return yield* Effect.fail(args.detail)
    }
  }
})

runMain(program, { disableErrorReporting: true })
