import { createSandbox, type Sandbox } from "@ai-hero/sandcastle"
import { Effect, FileSystem, Path, type Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { resolveAgentFile, type AgentFile } from "./agents"
import { checkedModelWindows, contextMarkJson, readModelWindows } from "./context-mark"
import { hostGitShim, withHostGitSafety } from "./host"
import { inheritedEnv, nonoSandboxProvider } from "./nono"
import { noSandboxProvider } from "./no-sandbox"
import { defaultSandbox, type SandboxKind } from "./args"
import { canRouteModel, defaultToolchainResolver, type HostTools, loginCheckCommand, modelCredentialFor, piAgentModels, type ToolchainResolver, withInstallFolders, within } from "./nono-profile"
import { runGit } from "./git-run"
import { orcCompletionLine } from "./pi"
import { OrcRunError, describeCause } from "./run-session"
import { openDatabase, orcHomeDir, updateStep } from "./run-history"
import { stepsForRun } from "./history-resume"
import { buildResumePlan, resolveTaskFile } from "./run-resume"
import { finishRun, historyFailure, recordChecksDone, recordChecksStart, recordFixDone, recordFixStart, recordImplementDone, recordImplementStart, recordNoMistakesDone, recordNoMistakesStart, recordResumePublish } from "./history-write"
import { failedReport, writeEvidence, writeReport, type HistoryRun, type OrcRunReport } from "./run-record"
import { runFull, type RunCheckpoints, type SandboxOps } from "./run-loop"
import { noMistakesBinary, noMistakesVersionProblem, subprocessNoMistakesRunner, type AllowWord, type NoMistakesHost, type QuestionAnswer } from "./no-mistakes"

export type { SandboxOps }

export interface OrcRunRequest {
  readonly cwd: string
  readonly taskFile: string | null | undefined
  readonly branch?: string | undefined
  readonly sandbox?: SandboxKind | undefined
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

const runLoginCheck = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  host: { readonly piBinary: string; readonly nodeBinary: string; readonly homeDir: string },
  cwd: string,
  preserveAgentDir = false
): Effect.Effect<void, OrcRunError> =>
  Effect.scoped(Effect.gen(function*() {
    const parts = loginCheckCommand(host, preserveAgentDir)
    const agentDir = Bun.env.PI_CODING_AGENT_DIR === undefined ? {} : { PI_CODING_AGENT_DIR: Bun.env.PI_CODING_AGENT_DIR }
    const handle = yield* spawner.spawn(ChildProcess.make(parts[0], parts.slice(1), { cwd, env: preserveAgentDir ? { ...inheritedEnv(Bun.env), ...agentDir } : inheritedEnv(Bun.env), extendEnv: false }))
    const [, , exitCode] = yield* Effect.all([
      handle.stdout.pipe(Stream.decodeText(), Stream.runDrain),
      handle.stderr.pipe(Stream.decodeText(), Stream.runDrain),
      handle.exitCode
    ], { concurrency: "unbounded" })
    if (exitCode !== 0) {
      return yield* refuse("orc: pi auth check found no opencode-go login, so a key held only in the keychain or in an environment variable is refused; add an opencode-go login to pi on the host and rerun")
    }
  })).pipe(
    Effect.mapError((cause) => cause instanceof OrcRunError ? cause : new OrcRunError({ message: "orc: the login check failed to run: " + String(cause) }))
  )

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

type ModelCredential = NonNullable<ReturnType<typeof modelCredentialFor>>

interface PreparedAgents {
  readonly folders: RunFolders
  readonly agent: AgentFile
  readonly fixer: AgentFile
  readonly credential: ModelCredential
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
  sandboxKind: SandboxKind
): Effect.Effect<PreparedAgents, OrcRunError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const folders = yield* prepareRunFolders(fs, path, runDir, effectiveTaskFile)
    const agent: AgentFile = yield* resolveAgentFile("implementer", {
      projectDir: checkout.projectDir,
      orcHome: home,
      agentsDir
    }).pipe(Effect.mapError((cause) => new OrcRunError({ message: cause.message })))
    const fixer: AgentFile = yield* resolveAgentFile("fixer", {
      projectDir: checkout.projectDir,
      orcHome: home,
      agentsDir
    }).pipe(Effect.mapError((cause) => new OrcRunError({ message: cause.message })))
    const piBinary = Bun.which("pi")
    const nodeBinary = Bun.which("node")
    const operatorHome = homedir()
    if (!canRouteModel(agent.model)) {
      return yield* refuse("orc: the agent file names model " + agent.model + ", and orc routes only opencode-go models through the sandbox")
    }
    if (piBinary === null) {
      return yield* refuse("orc: pi is not on the host PATH")
    }
    if (nodeBinary === null) {
      return yield* refuse("orc: node is not on the host PATH")
    }
    const credential = modelCredentialFor(agent.model, { piBinary, nodeBinary, homeDir: operatorHome })
    if (credential === null) {
      return yield* refuse("orc: the agent file names model " + agent.model + ", and orc routes only opencode-go models through the sandbox")
    }
    const host: HostTools = { piBinary, nodeBinary, homeDir: operatorHome }
    const preserveAgentDir = sandboxKind === "none"
    yield* runLoginCheck(spawner, host, checkout.projectDir, preserveAgentDir)
    const windows = yield* readModelWindows(spawner, host, folders.runDir, preserveAgentDir)
    const checked = yield* Effect.fromResult(checkedModelWindows([agent.model, fixer.model], windows)).pipe(
      Effect.mapError((message) => new OrcRunError({ message }))
    )
    yield* fs.writeFileString(path.join(folders.piAgentDir, "models.json"), piAgentModels(credential, checked)).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot write the agent models file: " + String(cause) }))
    )
    yield* fs.writeFileString(path.join(folders.piAgentDir, "settings.json"), contextMarkJson(checked)).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot write the agent settings file: " + String(cause) }))
    )
    return { folders, agent, fixer, credential }
  })

const requireNoMistakes = (options: NoMistakesHost, cwd: string): Effect.Effect<void, OrcRunError> =>
  noMistakesVersionProblem(options, cwd).pipe(Effect.flatMap((problem) => problem === null ? Effect.void : refuse(problem)))

const readTaskFile = (
  fs: FileSystem.FileSystem,
  home: string,
  checkout: Checkout,
  supplied: string | null | undefined
): Effect.Effect<string, OrcRunError, FileSystem.FileSystem | Path.Path> =>
  Effect.acquireUseRelease(
    openDatabase(home).pipe(Effect.mapError((cause) => historyFailure("open", cause))),
    (db) => resolveTaskFile(db, fs, checkout.branch, checkout.projectDir, supplied),
    (db) => Effect.sync(() => db.close())
  )

const openSandboxForRun = (
  kind: SandboxKind,
  git: string,
  checkout: Checkout,
  folders: RunFolders,
  credential: ModelCredential,
  hostPath: string | undefined,
  toolchain: ToolchainResolver
): Effect.Effect<Sandbox, OrcRunError> =>
  Effect.tryPromise({
    try: () => createSandbox({
      branch: checkout.branch,
      sandbox: kind === "none"
        ? noSandboxProvider({ piSessionDir: folders.piSessionDir, hostSessionsDir: folders.hostSessionsDir })
        : nonoSandboxProvider({ piSessionDir: folders.piSessionDir, piAgentDir: folders.piAgentDir, modelCredential: credential, hostPath, toolchain }),
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
    const hostPath = Bun.env.PATH
    const toolchain = yield* toolchainFromEnv(Bun.env.ORC_TOOLCHAIN_DIRS, homedir())
    const git = yield* openHostGit(fs, path)
    const checkout = yield* openCheckout(fs, path, spawner, git, request.cwd, request.branch, runId, parseRefuseMarkers(Bun.env.ORC_REFUSE_MARKERS))
    const runDir = path.join(home, "runs", runId)
    const effectiveTaskFile = yield* readTaskFile(fs, home, checkout, request.taskFile)
    const noMistakes = { spawner, binary: noMistakesBinary(Bun.env.ORC_NO_MISTAKES_BIN), pathEnv: hostPath ?? "", git: checkout.git }
    const { folders, agent, fixer, credential } = yield* prepareAgents(fs, path, spawner, checkout, home, runDir, effectiveTaskFile, request.agentsDir, request.sandbox ?? defaultSandbox).pipe(
      Effect.tap(() => requireNoMistakes(noMistakes, checkout.projectDir)),
      Effect.onError(() => fs.remove(runDir, { recursive: true }).pipe(Effect.result))
    )
    const started = new Date().toISOString()
    const sandbox: Sandbox = yield* openSandboxForRun(request.sandbox ?? defaultSandbox, git, checkout, folders, credential, hostPath, toolchain)
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
      taskPath: folders.taskPath, agent, fixer, branch: checkout.branch, started,
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
    const checkpoints: RunCheckpoints = {
      implementStart: (started) => recordImplementStart(db, run, started, resume.implementSessionFile ?? undefined),
      implementDone: (outcome, started, ended) => recordImplementDone(db, run, { agentPath: run.agent.path, sessionFile: outcome.sessionFile, tokens: outcome.tokens, commits: outcome.commits, implementPassed: outcome.completed }, started, ended),
      checksRoundStart: (round, started) => recordChecksStart(db, run.runId, round, started),
      checksRoundDone: (round) => recordChecksDone(db, run.runId, round),
      fixStart: (attempt, started) => recordFixStart(db, run.runId, attempt, run.fixer.path, started, attempt === 1 ? resume.fixSessionFile ?? undefined : undefined),
      fixDone: (fix) => recordFixDone(db, run.runId, fix),
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
            yield* recordImplementDone(db, run, { agentPath: run.agent.path, sessionFile: null, tokens: null, commits: null, implementPassed: false }, run.started, now).pipe(Effect.orElseSucceed(() => undefined))
          }
          const failed = failedReport(run, error.message)
          yield* writeEvidence(run, failed).pipe(Effect.orElseSucceed(() => undefined))
          yield* writeReport(run, failed).pipe(Effect.orElseSucceed(() => undefined))
          yield* finishRun(db, run.runId, failed, new Date().toISOString()).pipe(Effect.orElseSucceed(() => undefined))
          return failed
        })
      )
    )
    yield* writeEvidence(run, report)
    yield* writeReport(run, report)
    yield* finishRun(db, run.runId, report, new Date().toISOString())
    return report
  })
