import { run as runSandbox, type AgentProvider, type RunResult } from "@ai-hero/sandcastle"
import { Effect, FileSystem, Path, type Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { resolveAgentFile, type AgentFile } from "./agents"
import { hostGitSafetyEnv, hostGitShim, withHostGitSafety } from "./host"
import { nonoSandboxProvider } from "./nono"
import { canRouteModel, loginCheckCommand, modelCredentialFor, piAgentModels } from "./nono-profile"
import { buildImplementPrompt, orcCompletionLine, piWithTools, sessionPrintedSignal } from "./pi"
import { OrcRunError, describeCause, noSession, readSession } from "./run-session"
import { openDatabase, orcHomeDir } from "./run-history"
import { failedReport, historyFailure, recordHistory, writeEvidence, type HistoryRun, type OrcRunCommit, type OrcRunReport } from "./run-record"

export interface OrcRunRequest {
  readonly cwd: string
  readonly taskFile: string
  readonly branch?: string | undefined
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

const gitEnv = (): Record<string, string> => ({
  PATH: Bun.env.PATH ?? "",
  HOME: Bun.env.HOME ?? "",
  ...hostGitSafetyEnv,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1"
})

const runGit = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  git: string,
  args: ReadonlyArray<string>,
  cwd: string
): Effect.Effect<{ readonly stdout: string; readonly exitCode: number }, OrcRunError> =>
  Effect.scoped(Effect.gen(function*() {
    const handle = yield* spawner.spawn(ChildProcess.make(git, [...args], { cwd, env: gitEnv(), extendEnv: false }))
    const [stdout, , exitCode] = yield* Effect.all([
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.decodeText(), Stream.runDrain),
      handle.exitCode
    ], { concurrency: "unbounded" })
    return { stdout, exitCode }
  })).pipe(
    Effect.mapError((cause) => cause instanceof OrcRunError ? cause : new OrcRunError({ message: "orc: git failed to run: " + String(cause) }))
  )

const runLoginCheck = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  host: { readonly piBinary: string; readonly nodeBinary: string; readonly homeDir: string },
  cwd: string
): Effect.Effect<void, OrcRunError> =>
  Effect.scoped(Effect.gen(function*() {
    const parts = loginCheckCommand(host)
    const handle = yield* spawner.spawn(ChildProcess.make(parts[0], parts.slice(1), { cwd }))
    const [, , exitCode] = yield* Effect.all([
      handle.stdout.pipe(Stream.decodeText(), Stream.runDrain),
      handle.stderr.pipe(Stream.decodeText(), Stream.runDrain),
      handle.exitCode
    ], { concurrency: "unbounded" })
    if (exitCode !== 0) {
      return yield* refuse("orc: pi auth check found no opencode-go credential, so this keychain-only setup is refused; add an opencode-go login to pi on the host and rerun")
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

const openCheckout = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  git: string,
  cwd: string,
  branchName: string | undefined,
  runId: string
): Effect.Effect<Checkout, OrcRunError> =>
  Effect.gen(function*() {
    const top = yield* runGit(spawner, git, ["rev-parse", "--show-toplevel"], cwd)
    if (top.exitCode !== 0) {
      return yield* refuse("orc: " + cwd + " sits in no git checkout")
    }
    const projectDir = yield* fs.realPath(top.stdout.trim()).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot resolve the checkout: " + String(cause) }))
    )
    for (const candidate of [path.join(projectDir, ".fm-slot-owner"), path.join(path.dirname(projectDir), ".fm-slot-owner")]) {
      if (yield* exists(fs, candidate)) {
        return yield* refuse("orc: " + candidate + " marks a firstmate checkout, and orc refuses to run in one")
      }
    }
    const status = yield* runGit(spawner, git, ["status", "--porcelain"], projectDir)
    if (status.exitCode !== 0) {
      return yield* refuse("orc: git status failed in " + projectDir)
    }
    const dirty = status.stdout.split("\n").filter((line) => line.trim() !== "").length
    if (dirty > 0) {
      return yield* refuse("orc: the checkout at " + projectDir + " holds " + dirty.toString() + " uncommitted changes, so commit or stash them before orc runs")
    }
    const branch = branchName ?? ("orc/" + runId)
    if (!shellSafeBranch.test(branch)) {
      return yield* refuse("orc: " + branch + " holds a shell metacharacter, so orc takes only letters, digits, '.', '_', '-' and '/' in a branch name")
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
  home: string,
  runId: string,
  taskFile: string
): Effect.Effect<RunFolders, OrcRunError> =>
  Effect.gen(function*() {
    const runDir = path.join(home, "runs", runId)
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

export const runAgentStep = (
  request: OrcRunRequest
): Effect.Effect<OrcRunReport, OrcRunError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const home = request.homeDir ?? orcHomeDir()
    const runId = request.runId ?? newRunId()
    const hostPath = Bun.env.PATH
    const git = yield* openHostGit(fs, path)
    const checkout = yield* openCheckout(fs, path, spawner, git, request.cwd, request.branch, runId)
    const folders = yield* prepareRunFolders(fs, path, home, runId, request.taskFile)
    const agent: AgentFile = yield* resolveAgentFile("implementer", {
      projectDir: checkout.projectDir,
      orcHome: home,
      agentsDir: request.agentsDir
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
    yield* runLoginCheck(spawner, { piBinary, nodeBinary, homeDir: operatorHome }, checkout.projectDir)
    yield* fs.writeFileString(path.join(folders.piAgentDir, "models.json"), piAgentModels(credential)).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot write the agent models file: " + String(cause) }))
    )
    const started = new Date().toISOString()
    const runInNono: SandboxRun = (agentProvider) =>
      runSandbox({
        agent: agentProvider,
        sandbox: nonoSandboxProvider({ piSessionDir: folders.piSessionDir, piAgentDir: folders.piAgentDir, modelCredential: credential, hostPath }),
        prompt: buildImplementPrompt(agent, folders.sandboxTaskPath),
        cwd: checkout.projectDir,
        branchStrategy: { type: "branch", branch: checkout.branch },
        completionSignal: orcCompletionLine,
        logging: { type: "file", path: path.join(folders.runDir, "agent.log") },
        name: "orc-" + runId
      })
    const report = yield* Effect.acquireUseRelease(
      openDatabase(home).pipe(Effect.mapError((cause) => historyFailure("open", cause))),
      (db) => runWithHistory(db, {
        fs, path, spawner, git: checkout.git, projectDir: checkout.projectDir, runId,
        runDir: folders.runDir, piSessionDir: folders.piSessionDir, hostSessionsDir: folders.hostSessionsDir,
        taskPath: folders.taskPath, agent, branch: checkout.branch, started
      }, runInNono),
      (db) => Effect.sync(() => db.close())
    )
    return report
  }))

export type SandboxRun = (agent: AgentProvider) => Promise<RunResult>

export const runWithHistory = (db: Database, run: HistoryRun, runInSandbox: SandboxRun): Effect.Effect<OrcRunReport, OrcRunError> =>
  Effect.gen(function*() {
    const report = yield* implement(run, runInSandbox).pipe(
      Effect.catchTag("OrcRunError", (error) => Effect.succeed(failedReport(run, error.message)))
    )
    yield* writeEvidence(run, report)
    yield* recordHistory(db, run, report)
    return report
  })

const implement = (run: HistoryRun, runInSandbox: SandboxRun): Effect.Effect<OrcRunReport, OrcRunError> =>
  Effect.gen(function*() {
    const agentProvider = piWithTools(run.agent, {
      hostSessionsDir: run.hostSessionsDir,
      sandboxSessionsDir: run.piSessionDir
    })
    const result: RunResult = yield* Effect.tryPromise({
      try: () => runInSandbox(agentProvider),
      catch: (cause) => new OrcRunError({ message: "orc: the agent run failed: " + describeCause(cause) })
    }).pipe(withHostGitSafety(run.git))
    const sessionId = result.iterations.map((iteration) => iteration.sessionId).find((id) => id !== undefined) ?? null
    const sessionRead = yield* readSession(run, agentProvider.sessionStorage, sessionId).pipe(
      Effect.map((session) => ({ session, failure: null })),
      Effect.catchTag("OrcRunError", (error) => Effect.succeed({ session: noSession, failure: error.message }))
    )
    const session = sessionRead.session
    const commits: Array<OrcRunCommit> = []
    for (const commit of result.commits) {
      const subject = yield* runGit(run.spawner, run.git, ["log", "-1", "--format=%s", commit.sha], run.projectDir).pipe(
        Effect.map((logged) => logged.exitCode === 0 ? logged.stdout.trim() : ""),
        Effect.orElseSucceed(() => "")
      )
      commits.push({ sha: commit.sha, subject })
    }
    const signaled = result.completionSignal === orcCompletionLine
    const verified = signaled && session.jsonl !== null && sessionPrintedSignal(session.jsonl, orcCompletionLine)
    const completed = verified && commits.length > 0
    const endReason = sessionRead.failure ?? (!verified
      ? "Pi's final reply did not stop cleanly with " + orcCompletionLine + " on its own line."
      : (commits.length > 0 ? "Pi committed " + commits.length.toString() + " on " + result.branch + "." : "Pi printed ORC_COMPLETE but made no commit on " + result.branch + "."))
    return {
      runId: run.runId,
      runDir: run.runDir,
      branch: result.branch,
      agentPath: run.agent.path,
      agentSource: run.agent.source,
      model: run.agent.model,
      sessionId,
      sessionFile: session.file,
      commits,
      tokens: session.usage,
      completed,
      markerVerified: verified,
      endReason
    }
  })
