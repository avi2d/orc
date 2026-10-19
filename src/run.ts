import { run as runSandbox, type RunResult } from "@ai-hero/sandcastle"
import { Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { resolveAgentFile, type AgentFile } from "./agents"
import { nonoSandboxProvider } from "./nono"
import { modelCredentialFor, piAgentModels, type ModelCredential } from "./nono-profile"
import { buildImplementPrompt, orcCompletionLine, piWithTools } from "./pi"
import { OrcRunError, describeCause, readSession } from "./run-session"
import { formatHistoryError, openDatabase, orcHomeDir, recordEvidence, recordRun, recordSignal, recordStep } from "./run-history"

export interface OrcRunRequest {
  readonly cwd: string
  readonly taskFile: string
  readonly branch?: string | undefined
  readonly homeDir?: string | undefined
  readonly runId?: string | undefined
  readonly agentsDir?: string | undefined
}

interface OrcRunCommit {
  readonly sha: string
  readonly subject: string
}

export interface OrcRunReport {
  readonly runId: string
  readonly runDir: string
  readonly branch: string
  readonly agentPath: string
  readonly agentSource: string
  readonly model: string
  readonly sessionId: string | null
  readonly sessionFile: string | null
  readonly commits: ReadonlyArray<OrcRunCommit>
  readonly inputTokens: number
  readonly outputTokens: number
  readonly completed: boolean
  readonly endReason: string
}

const refuse = (message: string): Effect.Effect<never, OrcRunError> => Effect.fail(new OrcRunError({ message }))

const historyFailure = (action: string, cause: unknown): OrcRunError =>
  new OrcRunError({ message: "orc: cannot " + action + " the run history: " + formatHistoryError(cause) })

const newRunId = (): string => {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)
  const random = Math.random().toString(16).slice(2, 8)
  return stamp + "-" + random
}

const gitEnv = (): Record<string, string> => ({
  PATH: Bun.env.PATH ?? "",
  HOME: Bun.env.HOME ?? "",
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

const exists = (fs: FileSystem.FileSystem, path: string): Effect.Effect<boolean, OrcRunError> =>
  fs.exists(path).pipe(
    Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot stat " + path + ": " + String(cause) }))
  )

export const formatReport = (report: OrcRunReport): string =>
  [
    "run id: " + report.runId,
    "run folder: " + report.runDir,
    "branch: " + report.branch,
    "agent file: " + report.agentPath + " (" + report.agentSource + ")",
    "model: " + report.model,
    "pi session: " + (report.sessionId ?? "none"),
    "session file: " + (report.sessionFile ?? "none"),
    "commits: " + report.commits.length.toString() + report.commits.map((commit) => " " + commit.sha).join(","),
    "input tokens: " + report.inputTokens.toString(),
    "output tokens: " + report.outputTokens.toString(),
    "status: " + (report.completed ? (report.commits.length > 0 ? "completed" : "no commit") : "incomplete"),
    report.endReason
  ].join("\n")

interface Checkout {
  readonly git: string
  readonly projectDir: string
  readonly branch: string
}

const openCheckout = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  cwd: string,
  branchName: string | undefined,
  runId: string
): Effect.Effect<Checkout, OrcRunError> =>
  Effect.gen(function*() {
    const git = Bun.which("git")
    if (git === null) {
      return yield* refuse("orc: git is not on the host PATH")
    }
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

export const runAgentStep = (
  request: OrcRunRequest
): Effect.Effect<OrcRunReport, OrcRunError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const home = request.homeDir ?? orcHomeDir()
    const runId = request.runId ?? newRunId()
    const checkout = yield* openCheckout(fs, path, spawner, request.cwd, request.branch, runId)
    const folders = yield* prepareRunFolders(fs, path, home, runId, request.taskFile)
    const agent: AgentFile = yield* resolveAgentFile("implementer", {
      projectDir: checkout.projectDir,
      orcHome: home,
      agentsDir: request.agentsDir
    }).pipe(Effect.mapError((cause) => new OrcRunError({ message: cause.message })))
    const piBinary = Bun.which("pi")
    if (piBinary === null) {
      return yield* refuse("orc: pi is not on the host PATH")
    }
    const nodeBinary = Bun.which("node")
    if (nodeBinary === null) {
      return yield* refuse("orc: node is not on the host PATH")
    }
    const credential = modelCredentialFor(agent.model, { piBinary, nodeBinary, homeDir: homedir() })
    if (credential === null) {
      return yield* refuse("orc: the agent file names model " + agent.model + ", and orc routes only opencode-go models through the sandbox")
    }
    yield* fs.writeFileString(path.join(folders.piAgentDir, "models.json"), piAgentModels(credential)).pipe(
      Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot write the agent models file: " + String(cause) }))
    )
    const started = new Date().toISOString()
    const report = yield* Effect.acquireUseRelease(
      openDatabase(home).pipe(Effect.mapError((cause) => historyFailure("open", cause))),
      (db) => runWithHistory(db, {
        fs, path, spawner, git: checkout.git, projectDir: checkout.projectDir, home, runId,
        runDir: folders.runDir, piSessionDir: folders.piSessionDir, piAgentDir: folders.piAgentDir,
        hostSessionsDir: folders.hostSessionsDir, taskPath: folders.taskPath, sandboxTaskPath: folders.sandboxTaskPath,
        agent, credential, branch: checkout.branch, started
      }),
      (db) => Effect.sync(() => db.close())
    )
    return report
  })

interface HistoryRun {
  readonly fs: FileSystem.FileSystem
  readonly path: Path.Path
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  readonly git: string
  readonly projectDir: string
  readonly home: string
  readonly runId: string
  readonly runDir: string
  readonly piSessionDir: string
  readonly piAgentDir: string
  readonly hostSessionsDir: string
  readonly taskPath: string
  readonly sandboxTaskPath: string
  readonly agent: AgentFile
  readonly credential: ModelCredential
  readonly branch: string
  readonly started: string
}

const runWithHistory = (db: Database, run: HistoryRun): Effect.Effect<OrcRunReport, OrcRunError> =>
  Effect.gen(function*() {
    const agentProvider = piWithTools(run.agent, {
      hostSessionsDir: run.hostSessionsDir,
      sandboxSessionsDir: run.piSessionDir
    })
    const result: RunResult = yield* Effect.tryPromise({
      try: () =>
        runSandbox({
          agent: agentProvider,
          sandbox: nonoSandboxProvider({ piSessionDir: run.piSessionDir, piAgentDir: run.piAgentDir, modelCredential: run.credential }),
          prompt: buildImplementPrompt(run.agent, run.sandboxTaskPath),
          cwd: run.projectDir,
          branchStrategy: { type: "branch", branch: run.branch },
          completionSignal: orcCompletionLine,
          logging: { type: "file", path: run.path.join(run.runDir, "agent.log") },
          name: "orc-" + run.runId
        }),
      catch: (cause) => new OrcRunError({ message: "orc: the agent run failed: " + describeCause(cause) })
    })
    const sessionId = result.iterations.map((iteration) => iteration.sessionId).find((id) => id !== undefined) ?? null
    const session = yield* readSession(run, agentProvider.sessionStorage, sessionId)
    const commits: Array<OrcRunCommit> = []
    for (const commit of result.commits) {
      const logged = yield* runGit(run.spawner, run.git, ["log", "-1", "--format=%s", commit.sha], run.projectDir)
      commits.push({ sha: commit.sha, subject: logged.exitCode === 0 ? logged.stdout.trim() : "" })
    }
    const completed = result.completionSignal === orcCompletionLine
    const endReason = completed
      ? (commits.length > 0 ? "Pi committed " + commits.length.toString() + " on " + result.branch + "." : "Pi printed ORC_COMPLETE but made no commit on " + result.branch + ".")
      : "Pi stopped without printing ORC_COMPLETE."
    const report: OrcRunReport = {
      runId: run.runId,
      runDir: run.runDir,
      branch: result.branch,
      agentPath: run.agent.path,
      agentSource: run.agent.source,
      model: run.agent.model,
      sessionId,
      sessionFile: session.file,
      commits,
      inputTokens: session.inputTokens,
      outputTokens: session.outputTokens,
      completed,
      endReason
    }
    yield* writeEvidence(run, report)
    yield* recordHistory(db, run, report, session.jsonl !== null)
    return report
  })

const writeEvidence = (run: HistoryRun, report: OrcRunReport): Effect.Effect<void, OrcRunError> => {
  const lines = [
    "Implement step for task " + run.taskPath + ".",
    "Agent file " + report.agentPath + " (" + report.agentSource + ") names model " + report.model + " with tools " + run.agent.tools.join(", ") + ".",
    report.sessionId === null ? "Pi stored no session." : "Pi session " + report.sessionId + " is stored at " + (report.sessionFile ?? "an unknown path") + ".",
    report.completed ? "Pi printed " + orcCompletionLine + "." : "Pi stopped without printing " + orcCompletionLine + ".",
    report.commits.length === 0 ? "Pi made no commit on " + report.branch + "." : "Commits on " + report.branch + ".",
    ...report.commits.map((commit) => commit.sha + " " + commit.subject),
    "Pi consumed " + report.inputTokens.toString() + " input tokens and " + report.outputTokens.toString() + " output tokens.",
  ]
  return run.fs.writeFileString(run.path.join(run.runDir, "implement-1.md"), lines.join("\n") + "\n").pipe(
    Effect.mapError((cause) => new OrcRunError({ message: "orc: cannot write the evidence file: " + String(cause) }))
  )
}

const recordHistory = (
  db: Database,
  run: HistoryRun,
  report: OrcRunReport,
  hasSession: boolean
): Effect.Effect<void, OrcRunError> =>
  Effect.gen(function*() {
    const ended = new Date().toISOString()
    const failed = (action: string) => (cause: unknown) => historyFailure(action, cause)
    yield* recordRun(db, {
      id: run.runId,
      project: run.projectDir,
      branch: report.branch,
      taskFile: run.taskPath,
      status: "succeeded",
      started: run.started,
      ended,
      endReason: report.endReason
    }).pipe(Effect.mapError(failed("record the run in")))
    const stepId = yield* recordStep(db, {
      runId: run.runId,
      name: "implement",
      attempt: 1,
      status: report.completed && report.commits.length > 0 ? "passed" : "failed",
      started: run.started,
      ended,
      agentFile: report.agentPath,
      piSessionFile: report.sessionFile
    }).pipe(Effect.mapError(failed("record the step in")))
    yield* recordEvidence(db, { stepId, direction: "in", path: run.taskPath, kind: "task" }).pipe(
      Effect.mapError(failed("record the task evidence in"))
    )
    yield* recordEvidence(db, { stepId, direction: "out", path: run.path.join(run.runDir, "implement-1.md"), kind: "evidence" }).pipe(
      Effect.mapError(failed("record the evidence file in"))
    )
    if (hasSession && report.sessionFile !== null) {
      yield* recordEvidence(db, { stepId, direction: "out", path: report.sessionFile, kind: "session" }).pipe(
        Effect.mapError(failed("record the session evidence in"))
      )
    }
    for (const signal of [
      { name: "input-tokens", value: report.inputTokens.toString() },
      { name: "output-tokens", value: report.outputTokens.toString() },
      { name: "commit-count", value: report.commits.length.toString() }
    ]) {
      yield* recordSignal(db, { stepId, name: signal.name, value: signal.value }).pipe(
        Effect.mapError(failed("record the signals in"))
      )
    }
  })

