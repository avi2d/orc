import { createSandbox, type Sandbox } from "@ai-hero/sandcastle"
import { Effect, FileSystem, Path, type Scope } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { resolveAgentFile, type AgentFile } from "./agents"
import { hostGitShim, withHostGitSafety } from "./host"
import { nonoSandboxProvider } from "./nono"
import { noSandboxProvider } from "./no-sandbox"
import type { SandboxKind } from "./args"
import { defaultToolchainResolver, type HostTools, type ToolchainResolver, withInstallFolders, within } from "./nono-profile"
import { routeOfAgents } from "./model-route"
import { readOrcConfig } from "./orc-config"
import { planSandbox, type SandboxPlan } from "./sandbox-plan"
import { runGit } from "./git-run"
import { orcCompletionLine } from "./pi"
import { OrcRunError, describeCause } from "./run-session"
import { openDatabase, orcHomeDir, updateStep } from "./run-history"
import { stepsForRun } from "./history-resume"
import { buildResumePlan, resolveSandboxKind, resolveTaskFile } from "./run-resume"
import { finishRun, historyFailure, recordChecksDone, recordChecksStart, recordFixDone, recordFixStart, recordHandoverEvidence, recordImplementDone, recordImplementStart, recordNoMistakesDone, recordNoMistakesStart, recordResumePublish } from "./history-write"
import { failedReport, writeEvidence, writeHandover, writeReport, type HistoryRun, type OrcRunCommit, type OrcRunReport } from "./run-record"
import { longSessionWarning, type LongSessionCounts } from "./long-session"
import { runFull, type RunCheckpoints, type SandboxOps } from "./run-loop"
import { noMistakesBinary, noMistakesVersionProblem, subprocessNoMistakesRunner, type AllowWord, type NoMistakesHost, type QuestionAnswer } from "./no-mistakes"

export type { SandboxOps }

export interface OrcRunRequest {
  readonly cwd: string
  readonly taskFile: string | null | undefined
  readonly branch?: string | undefined
  readonly sandbox?: SandboxKind | undefined
  readonly tokenFile?: string | undefined
  readonly provider?: string | undefined
  readonly allow?: ReadonlyArray<AllowWord> | undefined
  readonly answers?: ReadonlyArray<QuestionAnswer> | undefined
  readonly homeDir?: string | undefined
  readonly runId?: string | undefined
  readonly agentsDir?: string | undefined
}

const refuse = (message: string): Effect.Effect<never, OrcRunError> => Effect.fail(new OrcRunError({ message }))

const newRunId = (): string => {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)
  const random = Math.random().toString(16).slice(2, 8)
  return stamp + "-" + random
}

const exists = (fs: FileSystem.FileSystem, path: string): Effect.Effect<boolean, OrcRunError> =>
  fs.exists(path).pipe(
    Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot stat " + path + ": " + String(cause) }))
  )

interface Checkout {
  readonly git: string
  readonly projectDir: string
  readonly branch: string
}

// Sandcastle interpolates the branch into host shell commands, so any other character can be expanded or run.
const shellSafeBranch = /^[A-Za-z0-9._/-]+$/

export const parseRefuseMarkers = (value: string | undefined): ReadonlyArray<string> =>
  value === undefined ? [] : value.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "")

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

export const openCheckout = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  git: string,
  cwd: string,
  branchName: string | undefined,
  runId: string,
  refuseMarkers: ReadonlyArray<string>
): Effect.Effect<Checkout, OrcRunError> =>
  Effect.gen(function*() {
    const top = yield* runGit(spawner, git, ["rev-parse", "--show-toplevel"], cwd)
    if (top.exitCode !== 0) {
      return yield* refuse("orc: " + cwd + " sits in no git checkout")
    }
    const projectDir = yield* fs.realPath(top.stdout.trim()).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot resolve the checkout: " + String(cause) }))
    )
    const candidates = refuseMarkers.flatMap((marker) => [path.join(projectDir, marker), path.join(path.dirname(projectDir), marker)])
    for (const candidate of candidates) {
      if (yield* exists(fs, candidate)) {
        return yield* refuse("orc: " + candidate + " marks this checkout as refused, so orc refuses to run in it")
      }
    }
    const status = yield* runGit(spawner, git, ["status", "--porcelain", "--", ".", ":(exclude).sandcastle/worktrees"], projectDir)
    if (status.exitCode !== 0) {
      return yield* refuse("orc: git status failed in " + projectDir)
    }
    const dirty = status.stdout.split("\n").filter((line) => line.trim() !== "").length
    if (dirty > 0) {
      return yield* refuse("orc: the checkout at " + projectDir + " holds " + dirty.toString() + " uncommitted changes, so commit or stash them before orc runs")
    }
    const branch = branchName ?? ("orc/" + runId)
    if (!shellSafeBranch.test(branch)) {
      return yield* refuse("orc: Sandcastle interpolates " + branch + " into host shell commands, so a branch holding a shell metacharacter is refused and orc takes only letters, digits, '.', '_', '-' and '/' in a branch name")
    }
    const named = yield* runGit(spawner, git, ["check-ref-format", "--branch", branch], projectDir)
    if (named.exitCode !== 0) {
      return yield* refuse("orc: " + branch + " is no usable branch name")
    }
    return { git, projectDir, branch }
  })

interface RunFolders {
  readonly runDir: string
  readonly piSessionDir: string
  readonly piAgentDir: string
  readonly hostSessionsDir: string
  readonly taskPath: string
  readonly sandboxTaskPath: string
}

const prepareRunFolders = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  runDir: string,
  taskFile: string
): Effect.Effect<RunFolders, OrcRunError> =>
  Effect.gen(function*() {
    const piSessionDir = path.join(runDir, "session")
    const piAgentDir = path.join(piSessionDir, "agent")
    const hostSessionsDir = path.join(runDir, "sessions")
    yield* fs.makeDirectory(piAgentDir, { recursive: true }).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot create the run folder " + runDir + ": " + String(cause) }))
    )
    yield* fs.makeDirectory(hostSessionsDir, { recursive: true }).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot create the sessions folder: " + String(cause) }))
    )
    const taskText = yield* fs.readFileString(taskFile).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot read the task file " + taskFile + ": " + String(cause) }))
    )
    const taskPath = path.join(runDir, "task.md")
    const sandboxTaskPath = path.join(piSessionDir, "task.md")
    yield* fs.writeFileString(taskPath, taskText).pipe(
      Effect.andThen(() => fs.writeFileString(sandboxTaskPath, taskText)),
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot write the task file: " + String(cause) }))
    )
    return { runDir, piSessionDir, piAgentDir, hostSessionsDir, taskPath, sandboxTaskPath }
  })

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
  agentsDir: string | undefined,
  sandboxKind: SandboxKind,
  pins: { readonly tokenFile: string | undefined; readonly provider: string | undefined }
): Effect.Effect<PreparedAgents, OrcRunError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const config = yield* readOrcConfig(home).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot read " + cause.file + ": " + cause.detail }))
    )
    const folders = yield* prepareRunFolders(fs, path, runDir, effectiveTaskFile)
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

const openSandboxForRun = (
  plan: SandboxPlan,
  git: string,
  checkout: Checkout,
  folders: RunFolders,
  hostPath: string | undefined,
  toolchain: ToolchainResolver,
  operatorEnv: Readonly<Record<string, string | undefined>>
): Effect.Effect<Sandbox, OrcRunError> =>
  Effect.tryPromise({
    try: () => createSandbox({
      branch: checkout.branch,
      sandbox: plan.kind === "none"
        ? noSandboxProvider({ piSessionDir: folders.piSessionDir, hostSessionsDir: folders.hostSessionsDir, piAgentDir: plan.own?.piAgentDir }, { ...operatorEnv, ...plan.own?.env })
        : nonoSandboxProvider({ piSessionDir: folders.piSessionDir, piAgentDir: folders.piAgentDir, modelCredential: plan.credential, hostPath, toolchain }),
      cwd: checkout.projectDir
    }),
    catch: (cause) => new OrcRunError({ message: "orc: the sandbox failed to start: " + describeCause(cause) })
  }).pipe(withHostGitSafety(git))

export const runAgentStep = (
  request: OrcRunRequest
): Effect.Effect<OrcRunReport, OrcRunError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const home = orcHomeDir(request.homeDir ?? Bun.env.ORC_HOME)
    const runId = request.runId ?? newRunId()
    const operatorEnv = { ...Bun.env }
    const hostPath = Bun.env.PATH
    const toolchain = yield* toolchainFromEnv(Bun.env.ORC_TOOLCHAIN_DIRS, homedir())
    const git = yield* openHostGit(fs, path)
    const checkout = yield* openCheckout(fs, path, spawner, git, request.cwd, request.branch, runId, parseRefuseMarkers(Bun.env.ORC_REFUSE_MARKERS))
    const runDir = path.join(home, "runs", runId)
    const { taskFile: effectiveTaskFile, sandbox: sandboxKind } = yield* readRunStart(fs, home, checkout, request)
    const noMistakes = { spawner, binary: noMistakesBinary(Bun.env.ORC_NO_MISTAKES_BIN), pathEnv: hostPath ?? "", git: checkout.git }
    const { folders, agent, fixer, plan } = yield* prepareAgents(fs, path, spawner, checkout, home, runDir, effectiveTaskFile, request.agentsDir, sandboxKind, { tokenFile: request.tokenFile, provider: request.provider }).pipe(
      Effect.tap(() => requireNoMistakes(noMistakes, checkout.projectDir)),
      Effect.onError(() => fs.remove(runDir, { recursive: true }).pipe(Effect.result))
    )
    const started = new Date().toISOString()
    const sandbox: Sandbox = yield* openSandboxForRun(plan, git, checkout, folders, hostPath, toolchain, operatorEnv)
    const ops: SandboxOps = {
      runAgent: (agentProvider, prompt, logFile, resumeSession) =>
        sandbox.run({
          agent: agentProvider,
          prompt,
          completionSignal: orcCompletionLine,
          logging: { type: "file", path: path.join(folders.runDir, logFile) },
          name: "orc-" + runId,
          ...(resumeSession === undefined ? {} : { resumeSession })
        }),
      execCheck: (command) => sandbox.exec(command)
    }
    const history: HistoryRun = {
      fs, path, spawner, git: checkout.git, projectDir: checkout.projectDir, runId,
      runDir: folders.runDir, piSessionDir: folders.piSessionDir, hostSessionsDir: folders.hostSessionsDir,
      taskPath: folders.taskPath, agent, fixer, branch: checkout.branch, sandbox: sandboxKind, started,
      worktreeDir: sandbox.worktreePath,
      noMistakes: subprocessNoMistakesRunner({ ...noMistakes, worktreeDir: sandbox.worktreePath }),
      allow: request.allow ?? [],
      answers: request.answers ?? []
    }
    const report = yield* Effect.acquireUseRelease(
      openDatabase(home).pipe(Effect.mapError((cause) => historyFailure("open", cause))),
      (db) => runWithHistory(db, history, ops),
      (db) => Effect.sync(() => db.close())
    ).pipe(
      Effect.ensuring(Effect.promise(() => sandbox.close().then(() => undefined, () => undefined)))
    )
    return report
  }))

export const runWithHistory = (db: Database, run: HistoryRun, ops: SandboxOps): Effect.Effect<OrcRunReport, OrcRunError> =>
  Effect.gen(function*() {
    const resume = yield* buildResumePlan(db, run)
    yield* recordResumePublish(db, run, resume)
    let implementLong: { readonly counts: LongSessionCounts; readonly commits: Array<OrcRunCommit>; readonly sessionFile: string | null } | null = null
    const checkpoints: RunCheckpoints = {
      implementStart: (started) => recordImplementStart(db, run, started, resume.implementSessionFile ?? undefined),
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
      fixDone: (fix, commits) => Effect.gen(function*() {
        yield* recordFixDone(db, run.runId, fix)
        if (implementLong !== null) {
          for (const commit of commits) {
            if (!implementLong.commits.some((kept) => kept.sha === commit.sha)) {
              implementLong.commits.push(commit)
            }
          }
        }
      }),
      noMistakesStart: (started) => recordNoMistakesStart(db, run.runId, started),
      noMistakesDone: (record) => recordNoMistakesDone(db, run, record)
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
          const failedHandover = yield* writeHandover(run, failed).pipe(Effect.orElseSucceed(() => null))
          if (failedHandover !== null) {
            yield* recordHandoverEvidence(db, run.runId, failedHandover).pipe(Effect.orElseSucceed(() => undefined))
          }
          yield* finishRun(db, run.runId, failed, new Date().toISOString()).pipe(Effect.orElseSucceed(() => undefined))
          return failed
        })
      )
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
