#!/usr/bin/env bun
import type { Database } from "bun:sqlite"
import { runMain } from "@effect/platform-bun/BunRuntime"
import { BunServices } from "@effect/platform-bun"
import { isatty } from "node:tty"
import { Config, Console, Effect } from "effect"
import packageJson from "../package.json" with { type: "json" }
import { appHomeDir, bundledAppDir, formatAppInstall, herdrAppSourceDir, installApp, readyBundledApp } from "./features/installing-the-app/index"
import { type OrcArgs, parseArgs } from "./app/args"
import { runChat } from "./features/chat/index"
import { helpText, overview, usageErrorText } from "./app/help"
import { runDispatch } from "./app/dispatch-cli"
import { RunnerError } from "./shared/process/index"
import { formatReport, formatReportOutcome, runAgentStep, runReportStep } from "./features/running-a-task/index"
import { backlogPaths, backlogRoot as backlogRootOf, type ReportKind, runDirFor } from "./entities/backlog/index"
import { encodeRefusalsJson, formatHistoryError, formatRefusalsTable, listAllRuns, listRuns, openDatabase, orcHomeDir, readRefusals } from "./entities/run-history/index"
import { encodeRunsJson, encodeShowJson, formatRunsTable, formatShow, readListedRuns, readOtherMachinesFrom, readRunsJsonRuns, readShow, readStepLog, recordStepScore, runsJson, withOtherMachines } from "./features/seeing-runs/index"

const readFailure = (error: unknown): string =>
  typeof error === "string" ? error : "orc: cannot read the run history: " + formatHistoryError(error)

const readHistory = <A, E, R extends BunServices.BunServices>(use: (db: Database) => Effect.Effect<A, E, R>) =>
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
    stdinIsTerminal: isatty(0),
    stdin: Effect.tryPromise({
      try: () => Bun.stdin.text(),
      catch: (cause) => new RunnerError({ detail: "cannot read stdin: " + String(cause) })
    }),
    stdoutIsTerminal: isatty(1)
  }).pipe(
    Effect.provide(BunServices.layer),
    Effect.catch((detail) => Console.error("orc: " + detail).pipe(Effect.andThen(Effect.fail(detail))))
  )

const scoreStep = (args: Extract<OrcArgs, { readonly kind: "ScoreStep" }>) =>
  Effect.gen(function*() {
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
  })

const chat = runChat(orcHomeDir(Bun.env.ORC_HOME), [process.execPath, Bun.main]).pipe(
  Effect.provide(BunServices.layer),
  Effect.catchTag("ChatError", (error) => Console.error(error.message).pipe(Effect.andThen(Effect.fail("orc chat refused")))),
  Effect.flatMap((exitCode) => exitCode === 0 ? Effect.void : Effect.fail("pi exited " + String(exitCode)))
)

const shipStep = (args: Extract<OrcArgs, { readonly kind: "RunAgent" }>) =>
  Effect.gen(function*() {
    const report = yield* runAgentStep({ cwd: process.cwd(), taskFile: args.taskFile, delivery: args.delivery, branch: args.branch, sandbox: args.sandbox, tokenFile: args.tokenFile, provider: args.provider, instructions: args.instructions, allow: args.allow, answers: args.answers, resumeRun: Bun.env.ORC_DISPATCH_RESUME_RUN, runId: Bun.env.ORC_DISPATCH_RUN_ID }).pipe(
      Effect.provide(BunServices.layer),
      Effect.catchTag("OrcRunError", (error) =>
        Console.error(error.message).pipe(Effect.andThen(Effect.fail("agent step refused")))
      )
    )
    yield* Console.log(formatReport(report))
    if (!report.completed) {
      return yield* Effect.fail("agent step failed")
    }
  })

const reportStep = (args: Extract<OrcArgs, { readonly kind: "RunAgent" }>, kind: ReportKind) =>
  Effect.gen(function*() {
    const outcome = yield* runReportStep({ cwd: process.cwd(), taskFile: args.taskFile, branch: args.branch, sandbox: args.sandbox, tokenFile: args.tokenFile, provider: args.provider, instructions: args.instructions }, kind).pipe(
      Effect.provide(BunServices.layer),
      Effect.catchTag("OrcRunError", (error) => Console.error(error.message).pipe(Effect.andThen(Effect.fail("report step refused"))))
    )
    yield* Console.log(formatReportOutcome(kind, outcome))
    if (outcome.kind !== "reported") {
      return yield* Effect.fail("report step failed")
    }
  })

const otherMachinesOf = (dispatchFile: string) =>
  readOtherMachinesFrom(dispatchFile).pipe(
    Effect.provide(BunServices.layer),
    Effect.catchTag("ConfigError", (error) =>
      Console.error("orc: " + error.file + ": " + error.detail).pipe(Effect.as({ runs: [], machines: [] }))
    )
  )

const printRuns = (args: Extract<OrcArgs, { readonly kind: "ListRuns" }>) =>
  Effect.gen(function*() {
    if (args.json) {
      const home = orcHomeDir(Bun.env.ORC_HOME)
      const listed = yield* readHistory((db) =>
        listAllRuns(db).pipe(
          Effect.flatMap((runs) => readListedRuns(db, runs)),
          Effect.flatMap((runs) => readRunsJsonRuns(runs, (runId) => runDirFor(home, runId)))
        )
      )
      const local = runsJson(listed)
      const others = args.local ? null : yield* otherMachinesOf(backlogPaths(backlogRootOf(orcHomeDir(Bun.env.ORC_HOME))).dispatchConfig)
      yield* Console.log(yield* encodeRunsJson(others === null ? local : withOtherMachines(local, others)))
    } else {
      yield* Console.log(formatRunsTable(yield* readHistory((db) => listRuns(db))))
    }
  })

const printRefusals = (args: Extract<OrcArgs, { readonly kind: "ListRefusals" }>) =>
  Effect.gen(function*() {
    const counts = yield* readHistory((db) => readRefusals(db))
    if (args.json) {
      yield* Console.log(yield* encodeRefusalsJson(counts))
    } else {
      yield* Console.log(formatRefusalsTable(counts))
    }
  })

const printShow = (args: Extract<OrcArgs, { readonly kind: "ShowRun" }>) =>
  Effect.gen(function*() {
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
  })

const printStepLog = (args: Extract<OrcArgs, { readonly kind: "ShowStepLog" }>) =>
  Effect.gen(function*() {
    const text = yield* readHistory((db) =>
      readStepLog(db, args.runId, args.stepId).pipe(
        Effect.catchTags({
          UnknownRun: () => Effect.fail("orc: unknown run " + args.runId),
          UnknownStep: () => Effect.fail("orc: run " + args.runId + " has no step " + args.stepId.toString()),
          NoStepLog: () => Effect.fail("orc: step " + args.stepId.toString() + " of run " + args.runId + " keeps no log")
        })
      )
    )
    yield* Effect.promise(() => Bun.write(Bun.stdout, text))
  })

const runInstallApp = Effect.gen(function*() {
  const home = yield* Config.String("HOME")
  const result = yield* readyBundledApp(herdrAppSourceDir(), bundledAppDir()).pipe(
    Effect.andThen((source) => installApp(source, appHomeDir(home))),
    Effect.provide(BunServices.layer),
    Effect.catchTag("AppInstallError", (error) => Console.error("orc app install: " + error.detail).pipe(Effect.andThen(Effect.fail("orc app install refused"))))
  )
  yield* Console.log(formatAppInstall(result))
})

const program = Effect.gen(function*() {
  const words = Bun.argv.slice(2)
  const args = parseArgs(words)
  switch (args.kind) {
    case "PrintVersion": {
      yield* Console.log(`orc ${packageJson.version}`)
      break
    }
    case "PrintHelp": {
      yield* Console.log(helpText(args.words))
      break
    }
    case "NoCommand": {
      yield* Console.error(overview())
      return yield* Effect.fail("orc takes a command")
    }
    case "ListRuns": {
      return yield* printRuns(args)
    }
    case "ListRefusals": {
      return yield* printRefusals(args)
    }
    case "ShowRun": {
      return yield* printShow(args)
    }
    case "ShowStepLog": {
      return yield* printStepLog(args)
    }
    case "ScoreStep": {
      return yield* scoreStep(args)
    }
    case "RunAgent": {
      return yield* args.taskKind === "ship" ? shipStep(args) : reportStep(args, args.taskKind)
    }
    case "Dispatch": {
      return yield* dispatch(args.args)
    }
    case "InstallApp": {
      return yield* runInstallApp
    }
    case "Chat": {
      return yield* chat
    }
    case "UsageError": {
      yield* Console.error(usageErrorText(args.detail, words))
      return yield* Effect.fail(args.detail)
    }
  }
})

if (import.meta.main) {
  runMain(program, { disableErrorReporting: true })
}
