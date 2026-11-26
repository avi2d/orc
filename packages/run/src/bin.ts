#!/usr/bin/env bun
import type { Database } from "bun:sqlite"
import { runMain } from "@effect/platform-bun/BunRuntime"
import { BunServices } from "@effect/platform-bun"
import { isatty } from "node:tty"
import { Decider } from "./shared/lib/index"
import { Config, Console, Effect, Schema } from "effect"
import packageJson from "../package.json" with { type: "json" }
import { appHomeDir, bundledAppDir, formatAppInstall, herdrAppSourceDir, installApp, readyBundledApp } from "./features/installing-the-app/index"
import { type OrcArgs, parseArgs } from "./app/args"
import { runChat } from "./features/chat/index"
import { type AccountName, signIn } from "./features/signing-in/index"
import { encodeUpdateJson, formatUpdate, releasesUrl, runUpdate } from "./features/updating-orc/index"
import { helpText, overview, usageErrorText } from "./app/help"
import { runDispatch } from "./app/dispatch-cli"
import { isStandinInvocation, runStandinInvocation } from "./entities/heavy-queue/index"
import { runQuotaCli } from "./app/quota-cli"
import { decodeJson, pueue, PueueState, queuedTasks, RunnerError, selfCommand } from "./shared/process/index"
import { formatReport, formatReportOutcome, runAgentStep, runReportStep } from "./features/running-a-task/index"
import { backlogPaths, backlogRoot as backlogRootOf, Rebase, type ReportKind, runDirFor } from "./entities/backlog/index"
import { encodeRefusalsJson, formatHistoryError, formatRefusalsTable, listAllRuns, listRuns, openDatabase, orcHomeDir, readRefusals } from "./entities/run-history/index"
import { encodeMachinesJson, encodeRunsJson, encodeShowJson, encodeVersionJson, formatRunsTable, formatShow, readListedRuns, readMachineVersions, readOtherMachinesFrom, readRunsJsonRuns, readShow, readStepLog, recordStepScore, runsJson, withOtherMachines, withQueued } from "./features/seeing-runs/index"

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
    self: selfCommand(process.execPath, Bun.main),
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

const chat = (sessionFile: string | null) => runChat(orcHomeDir(Bun.env.ORC_HOME), selfCommand(process.execPath, Bun.main), sessionFile, Bun.env.ORC_CHAT_DRAWER_LEASE ?? null).pipe(
  Effect.provide(BunServices.layer),
  Effect.catchTag("ChatError", (error) => Console.error(error.message).pipe(Effect.andThen(Effect.fail("orc chat refused")))),
  Effect.flatMap((exitCode) => exitCode === 0 ? Effect.void : Effect.fail("pi exited " + String(exitCode)))
)

const AnswerDeciders = Schema.Record(Schema.String, Decider)

const shipStep = (args: Extract<OrcArgs, { readonly kind: "RunAgent" }>) =>
  Effect.gen(function*() {
    const rawRebase = Bun.env.ORC_DISPATCH_REBASE
    const rebase = rawRebase === undefined ? undefined : yield* decodeJson(rawRebase, Rebase, "ORC_DISPATCH_REBASE").pipe(
      Effect.catchTag("RunnerError", (error) => Console.error(error.detail).pipe(Effect.andThen(Effect.fail("agent step refused"))))
    )
    const deciders = yield* decodeJson(Bun.env.ORC_DISPATCH_ANSWER_DECIDERS ?? "{}", AnswerDeciders, "ORC_DISPATCH_ANSWER_DECIDERS").pipe(
      Effect.catchTag("RunnerError", (error) => Console.error(error.detail).pipe(Effect.andThen(Effect.fail("agent step refused"))))
    )
    const answers = args.answers.map((answer) => ({ ...answer, decider: (Object.hasOwn(deciders, answer.question) ? deciders[answer.question] : undefined) ?? "owner" as const }))
    const report = yield* runAgentStep({ rebase, cwd: process.cwd(), taskFile: args.taskFile, delivery: args.delivery, branch: args.branch, sandbox: args.sandbox, tokenFile: args.tokenFile, provider: args.provider, implementerModel: args.implementerModel, fixerModel: args.fixerModel, implementerThinking: args.implementerThinking, fixerThinking: args.fixerThinking, instructions: args.instructions, allow: args.allow, answers, resumeRun: Bun.env.ORC_DISPATCH_RESUME_RUN, runId: Bun.env.ORC_DISPATCH_RUN_ID }).pipe(
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
    const outcome = yield* runReportStep({ cwd: process.cwd(), taskFile: args.taskFile, branch: args.branch, sandbox: args.sandbox, tokenFile: args.tokenFile, provider: args.provider, implementerModel: args.implementerModel, fixerModel: args.fixerModel, implementerThinking: args.implementerThinking, fixerThinking: args.fixerThinking, instructions: args.instructions }, kind).pipe(
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

const printMachines = () =>
  Effect.gen(function*() {
    const document = yield* readMachineVersions(backlogPaths(backlogRootOf(orcHomeDir(Bun.env.ORC_HOME))).dispatchConfig, packageJson.version).pipe(
      Effect.provide(BunServices.layer),
      Effect.catchTag("ConfigError", (error) => Console.error("orc: " + error.file + ": " + error.detail).pipe(Effect.andThen(Effect.fail("dispatch.json unreadable"))))
    )
    yield* Console.log(yield* encodeMachinesJson(document))
  })

const queuedOf = (home: string) =>
  pueue(["status", "--json"]).pipe(
    Effect.flatMap((text) => decodeJson(text, PueueState, "pueue status --json")),
    Effect.map((state) => queuedTasks(state, home)),
    Effect.provide(BunServices.layer),
    Effect.catchTag("RunnerError", () => Effect.succeed([]))
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
      const local = withQueued(runsJson(listed), yield* queuedOf(home))
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
  const result = yield* readyBundledApp(Bun.isStandaloneExecutable ? null : herdrAppSourceDir(), bundledAppDir()).pipe(
    Effect.andThen((source) => installApp(source, appHomeDir(home))),
    Effect.provide(BunServices.layer),
    Effect.catchTag("AppInstallError", (error) => Console.error("orc app install: " + error.detail).pipe(Effect.andThen(Effect.fail("orc app install refused"))))
  )
  yield* Console.log(formatAppInstall(result))
})

const login = (account: AccountName) => signIn(orcHomeDir(Bun.env.ORC_HOME), account, Bun.env, process.platform).pipe(
  Effect.provide(BunServices.layer),
  Effect.catchTag("SignInError", (error) => Console.error(error.message).pipe(Effect.andThen(Effect.fail("orc login refused")))),
  Effect.flatMap((signedIn) => Console.log("orc login " + account + ": signed in with " + signedIn.folderVar + "=" + signedIn.folder))
)

const update = (args: Extract<OrcArgs, { readonly kind: "Update" }>) =>
  Effect.gen(function*() {
    const result = yield* runUpdate({
      home: orcHomeDir(Bun.env.ORC_HOME),
      env: Bun.env,
      running: packageJson.version,
      main: Bun.main,
      executable: process.execPath,
      releases: releasesUrl
    }).pipe(Effect.provide(BunServices.layer))
    yield* Console.log(args.json ? yield* encodeUpdateJson(result) : formatUpdate(result))
    if (result.outcome === "failed") {
      return yield* Effect.fail("orc update failed")
    }
  })

const program = Effect.gen(function*() {
  const words = Bun.argv.slice(2)
  const args = parseArgs(words)
  switch (args.kind) {
    case "PrintVersion": {
      yield* Console.log(`orc ${packageJson.version}`)
      break
    }
    case "ShowVersion": {
      yield* Console.log(yield* encodeVersionJson(packageJson.version))
      break
    }
    case "ListMachines": {
      return yield* printMachines()
    }
    case "Quota": {
      return yield* runQuotaCli(orcHomeDir(Bun.env.ORC_HOME), args.json).pipe(
        Effect.provide(BunServices.layer),
        Effect.catchTag("ConfigError", (error) => Console.error("orc: " + error.file + ": " + error.detail).pipe(Effect.andThen(Effect.fail("dispatch.json unreadable"))))
      )
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
    case "Login": {
      return yield* login(args.account)
    }
    case "Chat": {
      return yield* chat(args.sessionFile)
    }
    case "Update": {
      return yield* update(args)
    }
    case "UsageError": {
      yield* Console.error(usageErrorText(args.detail, words))
      return yield* Effect.fail(args.detail)
    }
  }
})

if (Bun.isStandaloneExecutable || import.meta.main) {
  const words = process.argv.slice(2)
  if (Bun.isStandaloneExecutable && isStandinInvocation(words[0] ?? "")) {
    process.exitCode = await runStandinInvocation(words)
  } else {
    runMain(program, { disableErrorReporting: true })
  }
}
