import { Console, Effect, FileSystem, Path, type Scope } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { resolveAgentFile, type AgentFile } from "./entities/agent/index"
import { answerWaitFromEnv } from "./entities/review-gate/index"
import { hostGitShim } from "./shared/sandbox/index"
import type { SandboxKind } from "./shared/sandbox/index"
import { defaultToolchainResolver, type HostTools, type ToolchainResolver, withInstallFolders, within } from "./shared/sandbox/index"
import { routeOfAgents } from "./shared/config/index"
import { readOrcConfig } from "./shared/config/index"
import { planSandbox, type SandboxPlan } from "./sandbox-plan"
import { type Checkout, openCheckout, parseRefuseMarkers } from "./entities/task-copy/index"
import { formatRefresh, refreshCheckout } from "./entities/task-copy/index"
import { OrcRunError } from "./shared/lib/index"
import { historyFailure, markRunStopped, openDatabase, orcHomeDir, stoppedEndReason, updateStep } from "./entities/run-history/index"
import { stepsForRun } from "./entities/run-history/index"
import { buildResumePlan, resolveSandboxKind, resolveTaskFile } from "./run-resume"
import { finishRun, recordChecksDone, recordChecksStart, recordFixDone, recordFixStart, recordHandoverEvidence, recordImplementDone, recordImplementStart, recordNoMistakesDone, recordNoMistakesStart, recordPullRequestDone, recordPullRequestStart, recordResumePublish, recordStepSession } from "./history-write"
import { failedReport, writeEvidence, writeHandover, writeReport, type HistoryRun, type OrcRunCommit, type OrcRunReport } from "./run-record"
import { longSessionWarning, type LongSessionCounts } from "./entities/agent/index"
import { runFull, type RunCheckpoints, type SandboxOps } from "./run-loop"
import { type ReportOutcome, type ReportRun, runReport } from "./report-run"
import { runDirFor, type ReportKind } from "./entities/backlog/index"
import { noMistakesBinary, noMistakesVersionProblem, type AllowWord, type NoMistakesHost, type QuestionAnswer } from "./entities/review-gate/index"
import { newRunId } from "./shared/lib/index"
import { prepareRunFolders, type RunFolders, runInstructions } from "./run-folders"
import { subprocessDeliverer } from "./run-deliverer"
import type { RunDelivery } from "./shared/config/index"
import { closeTaskCopy, openTaskCopy, writeAgentGitConfig } from "./entities/task-copy/index"
import { ensureHeavyQueue, readHeavySettings } from "./entities/heavy-queue/index"
import { withHeavyPath } from "./entities/heavy-queue/index"
import { agentGitConfig, agentOps, installCopy, openAgentExec } from "./run-exec"
import type { PiPacing } from "./entities/agent/index"

export type { SandboxOps }

export interface OrcRunRequest {
  readonly cwd: string
  readonly taskFile: string | null | undefined
  readonly delivery?: RunDelivery | undefined
  readonly branch?: string | undefined
  readonly sandbox?: SandboxKind | undefined
  readonly tokenFile?: string | undefined
  readonly provider?: string | undefined
  readonly instructions?: string | undefined
  readonly allow?: ReadonlyArray<AllowWord> | undefined
  readonly answers?: ReadonlyArray<QuestionAnswer> | undefined
  readonly homeDir?: string | undefined
  readonly runId?: string | undefined
  readonly agentsDir?: string | undefined
}

const refuse = (message: string): Effect.Effect<never, OrcRunError> => Effect.fail(new OrcRunError({ message }))

// The sandbox reads each folder whole, so a folder holding HOME would hand it the operator's credentials.
export const toolchainFromEnv = (value: string | undefined, home: string): Effect.Effect<ToolchainResolver, OrcRunError> =>
  Effect.gen(function*() {
    const entries = (value ?? "").split(":").map((entry) => entry.trim()).filter((entry) => entry !== "")
    const folders: Array<string> = []
    for (const entry of entries) {
      const folder = entry.replace(/\/+$/, "")
      if (!entry.startsWith("/")) {
        return yield* refuse("orc: ORC_TOOLCHAIN_DIRS names " + entry + ", which is not an absolute path")
      }
      if (folder === "" || within(folder, home)) {
        return yield* refuse("orc: ORC_TOOLCHAIN_DIRS names " + entry + ", which holds HOME, and the sandbox reads each named folder whole")
      }
      folders.push(folder)
    }
    return withInstallFolders(defaultToolchainResolver(home), folders)
  })

const defaultIdleTimeoutSeconds = 45 * 60

export const idleTimeoutFromEnv = (value: string | undefined): Effect.Effect<number, OrcRunError> => {
  const text = (value ?? "").trim()
  if (text === "") {
    return Effect.succeed(defaultIdleTimeoutSeconds)
  }
  return /^[1-9]\d*$/.test(text)
    ? Effect.succeed(Number(text))
    : refuse("orc: ORC_IDLE_TIMEOUT_SECONDS is " + text + ", which is not a whole number of seconds above zero")
}


const openHostGit = (fs: FileSystem.FileSystem, path: Path.Path): Effect.Effect<string, OrcRunError, Scope.Scope> => {
  const realGit = Bun.which("git")
  return realGit === null
    ? refuse("orc: git is not on the host PATH")
    : hostGitShim(fs, path, realGit).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot write the host git shim: " + String(cause) }))
    )
}

interface PreparedAgents {
  readonly folders: RunFolders
  readonly agent: AgentFile
  readonly fixer: AgentFile
  readonly plan: SandboxPlan
}

const prepareAgents = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  checkout: Checkout,
  home: string,
  runDir: string,
  effectiveTaskFile: string,
  instructionsFile: string | null,
  agentsDir: string | undefined,
  sandboxKind: SandboxKind,
  pins: { readonly tokenFile: string | undefined; readonly provider: string | undefined }
): Effect.Effect<PreparedAgents, OrcRunError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const config = yield* readOrcConfig(home).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot read " + cause.file + ": " + cause.detail }))
    )
    const folders = yield* prepareRunFolders(fs, path, runDir, effectiveTaskFile, instructionsFile)
    const agent: AgentFile = yield* resolveAgentFile("implementer", {
      projectDir: checkout.projectDir,
      orcHome: home,
      agentsDir,
      configModel: { file: config.file, model: config.models?.implementer }
    }).pipe(Effect.mapError((cause) => new OrcRunError({ message: cause.message })))
    const fixer: AgentFile = yield* resolveAgentFile("fixer", {
      projectDir: checkout.projectDir,
      orcHome: home,
      agentsDir,
      configModel: { file: config.file, model: config.models?.fixer }
    }).pipe(Effect.mapError((cause) => new OrcRunError({ message: cause.message })))
    const piBinary = Bun.which("pi")
    const nodeBinary = Bun.which("node")
    const models = { agent: agent.model, fixer: fixer.model }
    const provider = yield* Effect.fromResult(routeOfAgents(config, models, pins.provider)).pipe(Effect.mapError((message) => new OrcRunError({ message })))
    if (piBinary === null) {
      return yield* refuse("orc: pi is not on the host PATH")
    }
    if (nodeBinary === null) {
      return yield* refuse("orc: node is not on the host PATH")
    }
    const host: HostTools = { piBinary, nodeBinary, homeDir: homedir() }
    const plan = yield* planSandbox(fs, path, spawner, host, { projectDir: checkout.projectDir, runDir: folders.runDir, piAgentDir: folders.piAgentDir }, models, { config, provider, tokenFileFlag: pins.tokenFile }, sandboxKind)
    return { folders, agent, fixer, plan }
  })

const requireNoMistakes = (options: NoMistakesHost, cwd: string): Effect.Effect<void, OrcRunError> =>
  noMistakesVersionProblem(options, cwd).pipe(Effect.flatMap((problem) => problem === null ? Effect.void : refuse(problem)))

interface RunStart {
  readonly taskFile: string
  readonly sandbox: SandboxKind
}

const readRunStart = (
  fs: FileSystem.FileSystem,
  home: string,
  checkout: Checkout,
  request: OrcRunRequest
): Effect.Effect<RunStart, OrcRunError, FileSystem.FileSystem | Path.Path> =>
  Effect.acquireUseRelease(
    openDatabase(home).pipe(Effect.mapError((cause) => historyFailure("open", cause))),
    (db) =>
      Effect.all({
        taskFile: resolveTaskFile(db, fs, checkout.branch, checkout.projectDir, request.taskFile),
        sandbox: resolveSandboxKind(db, checkout.branch, checkout.projectDir, request.sandbox)
      }),
    (db) => Effect.sync(() => db.close())
  )

interface OpenedRun {
  readonly fs: FileSystem.FileSystem
  readonly path: Path.Path
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  readonly home: string
  readonly runId: string
  readonly git: string
  readonly checkout: Checkout
  readonly runDir: string
  readonly effectiveTaskFile: string
  readonly instructionsFile: string | null
  readonly sandboxKind: SandboxKind
}


const openRun = (
  request: OrcRunRequest
): Effect.Effect<OpenedRun, OrcRunError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const home = orcHomeDir(request.homeDir ?? Bun.env.ORC_HOME)
    const heavySettings = yield* readHeavySettings(home).pipe(Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot read " + cause.detail })))
    yield* ensureHeavyQueue(home, heavySettings).pipe(Effect.mapError((cause) => new OrcRunError({ message: "orc: the heavy queue failed to start: " + cause.detail })))
    const runId = request.runId ?? newRunId()
    const instructionsFile = yield* runInstructions(fs, path, request.cwd, request.instructions)
    const git = yield* openHostGit(fs, path)
    const checkout = yield* openCheckout(fs, path, spawner, git, request.cwd, request.branch, runId, parseRefuseMarkers(Bun.env.ORC_REFUSE_MARKERS))
    yield* Console.log(formatRefresh(checkout.projectDir, yield* refreshCheckout(checkout.projectDir)))
    const runDir = runDirFor(home, runId)
    const { taskFile: effectiveTaskFile, sandbox: sandboxKind } = yield* readRunStart(fs, home, checkout, request)
    return { fs, path, spawner, home, runId, git, checkout, runDir, effectiveTaskFile, instructionsFile, sandboxKind }
  })

const prepareRunAgents = (opened: OpenedRun, request: OrcRunRequest) =>
  prepareAgents(
    opened.fs, opened.path, opened.spawner, opened.checkout, opened.home, opened.runDir, opened.effectiveTaskFile, opened.instructionsFile, request.agentsDir, opened.sandboxKind,
    { tokenFile: request.tokenFile, provider: request.provider }
  )

const piPacing = (idleTimeoutSeconds: number): PiPacing => ({ tickMillis: 60_000, idleMillis: idleTimeoutSeconds * 1000 })

const removeRunDir = (opened: OpenedRun) => opened.fs.remove(opened.runDir, { recursive: true }).pipe(Effect.result)

// A report run starts Pi on the host in its run folder, outside any task copy, so a nono run would go unsandboxed without saying so.
export const runReportStep = (
  request: OrcRunRequest,
  kind: ReportKind
): Effect.Effect<ReportOutcome, OrcRunError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(Effect.gen(function*() {
    const toolchain = yield* toolchainFromEnv(Bun.env.ORC_TOOLCHAIN_DIRS, homedir())
    const idleTimeoutSeconds = yield* idleTimeoutFromEnv(Bun.env.ORC_IDLE_TIMEOUT_SECONDS)
    const opened = yield* openRun(request)
    if (opened.sandboxKind !== "none") {
      return yield* refuse("orc: a " + kind + " run starts Pi on the host in its run folder, so it takes --sandbox none and refuses --sandbox " + opened.sandboxKind)
    }
    const { folders, agent, plan } = yield* prepareRunAgents(opened, request).pipe(Effect.onError(() => removeRunDir(opened)))
    const exec = yield* openAgentExec(plan, folders, folders.runDir, toolchain, { ...Bun.env, PATH: withHeavyPath(opened.home, Bun.env.PATH ?? "") })
    const run: ReportRun = {
      kind, runId: opened.runId, runDir: folders.runDir, projectDir: opened.checkout.projectDir, branch: opened.checkout.branch, sandbox: opened.sandboxKind,
      taskPath: folders.taskPath, instructions: folders.instructionsPath, hostSessionsDir: folders.hostSessionsDir, agent, started: new Date().toISOString(),
      exec, pacing: piPacing(idleTimeoutSeconds)
    }
    return yield* Effect.acquireUseRelease(
      openDatabase(opened.home).pipe(Effect.mapError((cause) => historyFailure("open", cause))),
      (db) => runReport(db, run),
      (db) => Effect.sync(() => db.close())
    )
  }))

export const runAgentStep = (
  request: OrcRunRequest
): Effect.Effect<OrcRunReport, OrcRunError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(Effect.gen(function*() {
    const hostPath = Bun.env.PATH
    const toolchain = yield* toolchainFromEnv(Bun.env.ORC_TOOLCHAIN_DIRS, homedir())
    const idleTimeoutSeconds = yield* idleTimeoutFromEnv(Bun.env.ORC_IDLE_TIMEOUT_SECONDS)
    const answerWaitSeconds = yield* answerWaitFromEnv(Bun.env.ORC_ANSWER_WAIT_SECONDS)
    const opened = yield* openRun(request)
    const { fs, path, spawner, home, runId, git, checkout, sandboxKind } = opened
    const noMistakes = { spawner, binary: noMistakesBinary(Bun.env.ORC_NO_MISTAKES_BIN), pathEnv: withHeavyPath(home, hostPath ?? ""), git: checkout.git }
    const { folders, agent, fixer, plan } = yield* prepareRunAgents(opened, request).pipe(
      Effect.tap(() => request.delivery === "direct-PR" ? Effect.void : requireNoMistakes(noMistakes, checkout.projectDir)),
      Effect.onError(() => removeRunDir(opened))
    )
    const started = new Date().toISOString()
    const copy = yield* openTaskCopy(fs, path, spawner, git, checkout, home)
    yield* Effect.addFinalizer(() => closeTaskCopy(spawner, git, checkout.projectDir, copy).pipe(Effect.catch((error) => Console.log(error.message))))
    yield* writeAgentGitConfig(spawner, git, Bun.which("git") ?? "git", checkout.projectDir, copy.dir, agentGitConfig(folders))
    const exec = yield* openAgentExec(plan, folders, copy.dir, toolchain, { ...Bun.env, PATH: withHeavyPath(home, Bun.env.PATH ?? "") })
    yield* installCopy(spawner, fs, path, exec, path.join(folders.runDir, "prepare.log"))
    const ops = agentOps({ spawner, fs, path, git }, exec, folders, piPacing(idleTimeoutSeconds))
    const history: HistoryRun = {
      fs, path, spawner, git: checkout.git, projectDir: checkout.projectDir, runId,
      runDir: folders.runDir, piSessionDir: folders.piSessionDir, hostSessionsDir: folders.hostSessionsDir,
      taskPath: folders.taskPath, instructions: folders.instructionsPath, agent, fixer, branch: checkout.branch, sandbox: sandboxKind, started,
      worktreeDir: copy.dir,
      delivery: subprocessDeliverer(request.delivery ?? "no-mistakes", { ...noMistakes, worktreeDir: copy.dir, branch: checkout.branch }),
      allow: request.allow ?? [],
      answers: request.answers ?? [],
      answerWaitSeconds
    }
    return yield* Effect.acquireUseRelease(
      openDatabase(home).pipe(Effect.mapError((cause) => historyFailure("open", cause))),
      (db) => runWithHistory(db, history, ops),
      (db) => Effect.sync(() => db.close())
    )
  }))

export const runWithHistory = (db: Database, run: HistoryRun, ops: SandboxOps): Effect.Effect<OrcRunReport, OrcRunError> =>
  Effect.gen(function*() {
    const resume = yield* buildResumePlan(db, run)
    yield* recordResumePublish(db, run, resume)
    let implementLong: { readonly counts: LongSessionCounts; readonly commits: Array<OrcRunCommit>; readonly sessionFile: string | null } | null = null
    const checkpoints: RunCheckpoints = {
      implementStart: (started) => recordImplementStart(db, run, started, resume.implementSessionFile ?? undefined),
      implementSession: (file) => recordStepSession(db, run.runId, "implement", 1, file),
      implementDone: (outcome, started, ended) => Effect.gen(function*() {
        yield* recordImplementDone(db, run, { agentPath: run.agent.path, sessionFile: outcome.sessionFile, tokens: outcome.tokens, commits: outcome.commits, sessionSize: outcome.sessionSize, implementPassed: outcome.completed }, started, ended)
        if (outcome.sessionSize !== null && longSessionWarning(outcome.sessionSize) !== null) {
          implementLong = { counts: outcome.sessionSize, commits: [...outcome.commits], sessionFile: outcome.sessionFile }
          const provisional: OrcRunReport = {
            runId: run.runId,
            runDir: run.runDir,
            branch: run.branch,
            agentPath: run.agent.path,
            agentSource: run.agent.source,
            model: run.agent.model,
            sessionId: outcome.sessionId,
            sessionFile: outcome.sessionFile,
            commits: [...outcome.commits],
            tokens: outcome.tokens,
            sessionSize: outcome.sessionSize,
            completed: false,
            markerVerified: outcome.markerVerified,
            implementPassed: outcome.completed,
            checksRounds: null,
            fixes: [],
            fixAttempts: 0,
            prLink: null,
            noMistakes: null,
            endReason: outcome.endReason
          }
          yield* writeHandover(run, provisional).pipe(Effect.orElseSucceed(() => null))
        }
      }),
      checksRoundStart: (round, started) => recordChecksStart(db, run.runId, round, started),
      checksRoundDone: (round) => recordChecksDone(db, run.runId, round),
      fixStart: (attempt, started) => recordFixStart(db, run.runId, attempt, run.fixer.path, started, attempt === 1 ? resume.fixSessionFile ?? undefined : undefined),
      fixSession: (attempt, file) => recordStepSession(db, run.runId, "fix", attempt, file),
      fixDone: (fix) => recordFixDone(db, run.runId, fix),
      noMistakesStart: (started) => recordNoMistakesStart(db, run.runId, started),
      noMistakesDone: (record) => recordNoMistakesDone(db, run, record),
      pullRequestStart: (started) => recordPullRequestStart(db, run.runId, started),
      pullRequestDone: (record) => recordPullRequestDone(db, run, record)
    }
    const report = yield* runFull(run, ops, resume, checkpoints).pipe(
      Effect.catchTag("OrcRunError", (error) =>
        Effect.gen(function*() {
          const existing = yield* stepsForRun(db, run.runId).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<{ readonly name: string; readonly status: string; readonly attempt: number }>))
          const now = new Date().toISOString()
          for (const step of existing) {
            if (step.status === "running") {
              yield* updateStep(db, run.runId, step.name, step.attempt, { status: "failed", ended: now }).pipe(Effect.orElseSucceed(() => false))
            }
          }
          if (!existing.some((step) => step.name === "implement")) {
            yield* recordImplementDone(db, run, { agentPath: run.agent.path, sessionFile: null, tokens: null, commits: null, sessionSize: null, implementPassed: false }, run.started, now).pipe(Effect.orElseSucceed(() => undefined))
          }
          const baseFailed = failedReport(run, error.message)
          const failed = implementLong === null ? baseFailed : { ...baseFailed, sessionSize: implementLong.counts, commits: implementLong.commits, sessionFile: implementLong.sessionFile }
          yield* writeEvidence(run, failed).pipe(Effect.orElseSucceed(() => undefined))
          yield* writeReport(run, failed).pipe(Effect.orElseSucceed(() => undefined))
          yield* finishRun(db, run.runId, failed, new Date().toISOString()).pipe(Effect.orElseSucceed(() => undefined))
          return failed
        })
      ),
      Effect.onInterrupt(() => markRunStopped(db, run.runId, new Date().toISOString(), stoppedEndReason))
    )
    yield* writeEvidence(run, report)
    yield* writeReport(run, report)
    const handover = yield* writeHandover(run, report)
    if (handover !== null) {
      yield* recordHandoverEvidence(db, run.runId, handover).pipe(Effect.orElseSucceed(() => undefined))
    }
    yield* finishRun(db, run.runId, report, new Date().toISOString())
    return report
  })
