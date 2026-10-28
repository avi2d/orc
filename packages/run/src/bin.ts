#!/usr/bin/env bun
import type { Database } from "bun:sqlite"
import { runMain } from "@effect/platform-bun/BunRuntime"
import { BunServices } from "@effect/platform-bun"
import { Console, Effect } from "effect"
import packageJson from "../package.json" with { type: "json" }
import { type OrcArgs, parseArgs } from "./args"
import { dispatchUsage } from "./dispatch/args"
import { runDispatch } from "./dispatch/cli"
import { RunnerError } from "./dispatch/runner"
import { runAgentStep } from "./run"
import { formatReport } from "./run-record"
import { encodeRunsJson, formatHistoryError, formatRunsTable, listRuns, openDatabase, orcHomeDir } from "./run-history"
import { recordStepScore } from "./run-scores"
import { encodeShowJson, formatShow, readShow } from "./show"

const usage = "Usage: orc [--version] [--help] | orc runs [--json] | orc show <run> [--json] | orc score <run> <step> <1 to 5> [note] | orc run [<task-file>] [--branch <name>] [--sandbox nono|none] [--allow ask-user] [--answer question-<id>=\"<text>\"] | " + dispatchUsage

const readFailure = (error: unknown): string =>
  typeof error === "string" ? error : "orc: cannot read the run history: " + formatHistoryError(error)

const readHistory = <A, E>(use: (db: Database) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    openDatabase(orcHomeDir(Bun.env.ORC_HOME)),
    use,
    (db) => Effect.sync(() => db.close())
  ).pipe(
    Effect.provide(BunServices.layer),
    Effect.catch((error) =>
      Console.error(readFailure(error)).pipe(Effect.andThen(Effect.fail("run history unavailable")))
    )
  )

const dispatch = (args: Extract<OrcArgs, { readonly kind: "Dispatch" }>["args"]) =>
  runDispatch(args, {
    home: orcHomeDir(Bun.env.ORC_HOME),
    cwd: process.cwd(),
    env: Bun.env,
    self: [process.execPath, Bun.main],
    stdin: Effect.tryPromise({
      try: () => Bun.stdin.text(),
      catch: (cause) => new RunnerError({ detail: "cannot read stdin: " + String(cause) })
    })
  }).pipe(
    Effect.provide(BunServices.layer),
    Effect.catch((detail) => Console.error("orc: " + detail).pipe(Effect.andThen(Effect.fail(detail))))
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
    case "ScoreStep": {
      yield* Effect.acquireUseRelease(
        openDatabase(orcHomeDir(Bun.env.ORC_HOME)),
        (db) =>
          recordStepScore(db, {
            runId: args.runId,
            step: args.step,
            score: args.score,
            note: args.note,
            scoredAt: new Date().toISOString()
          }),
        (db) => Effect.sync(() => db.close())
      ).pipe(
        Effect.provide(BunServices.layer),
        Effect.catchTags({
          UnknownRun: (error) =>
            Console.error("orc score: unknown run " + error.runId).pipe(Effect.andThen(Effect.fail("orc score refused"))),
          UnknownStep: (error) =>
            Console.error("orc score: unknown step " + error.step + " in run " + error.runId).pipe(
              Effect.andThen(Effect.fail("orc score refused"))
            ),
          InvalidScore: (error) =>
            Console.error(`orc score takes a score from 1 to 5, got "${error.score}"`).pipe(
              Effect.andThen(Effect.fail("orc score refused"))
            )
        }),
        Effect.catch((error) =>
          Console.error(readFailure(error)).pipe(Effect.andThen(Effect.fail("run history unavailable")))
        )
      )
      yield* Console.log(`orc score recorded ${args.score} for ${args.step} in ${args.runId}`)
      break
    }
    case "RunAgent": {
      const report = yield* runAgentStep({ cwd: process.cwd(), taskFile: args.taskFile, branch: args.branch, sandbox: args.sandbox, allow: args.allow, answers: args.answers }).pipe(
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
    case "Dispatch": {
      return yield* dispatch(args.args)
    }
    case "UsageError": {
      yield* Console.error(`${args.detail}\n${usage}`)
      return yield* Effect.fail(args.detail)
    }
  }
})

runMain(program, { disableErrorReporting: true })
