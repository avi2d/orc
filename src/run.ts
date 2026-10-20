import { createSandbox, type Sandbox } from "@ai-hero/sandcastle"
import { Effect, FileSystem, Option, Path, type Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { resolveAgentFile, type AgentFile } from "./agents"
import { hostGitShim, withHostGitSafety } from "./host"
import { nonoSandboxProvider } from "./nono"
import { canRouteModel, loginCheckCommand, modelCredentialFor, piAgentModels } from "./nono-profile"
import { runGit } from "./git-run"
import { orcCompletionLine } from "./pi"
import { OrcRunError, describeCause } from "./run-session"
import { checksRoundsForRun, fixesForRun, latestRunForBranch, openDatabase, orcHomeDir, sessionIdFromFile, stepsForRun, updateStep } from "./run-history"
import { finishRun, historyFailure, recordChecksDone, recordChecksStart, recordFixDone, recordFixStart, recordImplementDone, recordImplementStart, recordNoMistakesDone, recordNoMistakesStart, recordRunStart } from "./history-write"
import { failedReport, writeEvidence, writeReport, type HistoryRun, type OrcRunReport } from "./run-record"
import { runFull, type ResumePlan, type RunCheckpoints, type SandboxOps } from "./run-loop"

export type { SandboxOps }

export interface OrcRunRequest {
  readonly cwd: string
  readonly taskFile: string | null | undefined
  readonly branch?: string | undefined
  readonly allow?: boolean | undefined
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
    const runDir = path.join(home, "runs", runId)
    const effectiveTaskFile = yield* Effect.acquireUseRelease(
      openDatabase(home).pipe(Effect.mapError((cause) => historyFailure("open", cause))),
      (db) => Effect.gen(function*() {
        const prior = yield* latestRunForBranch(db, checkout.projectDir, checkout.branch).pipe(Effect.mapError((cause) => historyFailure("read", cause)))
        if (request.taskFile === undefined || request.taskFile === null) {
          if (prior === null) {
            return yield* refuse("orc: no previous run for branch " + checkout.branch + ", so pass a task file")
          }
          return prior.taskFile
        }
        if (prior !== null) {
          const steps = yield* stepsForRun(db, prior.id).pipe(Effect.mapError((cause) => historyFailure("read", cause)))
          if (steps.some((step) => step.name === "implement" && step.status === "passed")) {
            const saved = yield* fs.readFileString(prior.taskFile).pipe(Effect.orElseSucceed(() => null))
            const supplied = yield* fs.readFileString(request.taskFile).pipe(Effect.orElseSucceed(() => null))
            if (saved !== null && supplied !== null && saved !== supplied) {
              return yield* refuse("orc: the task file changed since branch " + checkout.branch + " passed a step, so resume refuses new intent with old progress")
            }
          }
        }
        return request.taskFile
      }),
      (db) => Effect.sync(() => db.close())
    )
    const prepared = yield* Effect.gen(function*() {
      const folders = yield* prepareRunFolders(fs, path, runDir, effectiveTaskFile)
      const agent: AgentFile = yield* resolveAgentFile("implementer", {
        projectDir: checkout.projectDir,
        orcHome: home,
        agentsDir: request.agentsDir
      }).pipe(Effect.mapError((cause) => new OrcRunError({ message: cause.message })))
      const fixer: AgentFile = yield* resolveAgentFile("fixer", {
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
      return { folders, agent, fixer, credential }
    }).pipe(
      Effect.onError(() => fs.remove(runDir, { recursive: true }).pipe(Effect.result))
    )
    const { folders, agent, fixer, credential } = prepared
    const started = new Date().toISOString()
    const sandbox: Sandbox = yield* Effect.tryPromise({
      try: () => createSandbox({
        branch: checkout.branch,
        sandbox: nonoSandboxProvider({ piSessionDir: folders.piSessionDir, piAgentDir: folders.piAgentDir, modelCredential: credential, hostPath }),
        cwd: checkout.projectDir
      }),
      catch: (cause) => new OrcRunError({ message: "orc: the sandbox failed to start: " + describeCause(cause) })
    }).pipe(withHostGitSafety(git))
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
      noMistakesPath: hostPath ?? "",
      allow: request.allow ?? false
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

const latestDiskSession = (run: HistoryRun, priorId: string): Effect.Effect<string | null, OrcRunError> =>
  Effect.gen(function*() {
    const dir = run.path.join(run.path.dirname(run.runDir), priorId, "sessions")
    const top = yield* run.fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
    const found: Array<{ readonly file: string; readonly mtime: number }> = []
    for (const sub of top) {
      const files = yield* run.fs.readDirectory(run.path.join(dir, sub)).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
      for (const file of files) {
        if (!file.endsWith(".jsonl")) {
          continue
        }
        const full = run.path.join(dir, sub, file)
        const info = yield* run.fs.stat(full).pipe(Effect.orElseSucceed(() => null))
        found.push({ file: full, mtime: info === null ? 0 : Option.match(info.mtime, { onNone: () => 0, onSome: (at) => at.getTime() }) })
      }
    }
    if (found.length === 0) {
      return null
    }
    return [...found].sort((a, b) => b.mtime - a.mtime)[0]?.file ?? null
  })

const buildResumePlan = (db: Database, run: HistoryRun): Effect.Effect<ResumePlan, OrcRunError> =>
  Effect.gen(function*() {
    const allow = run.allow ?? false
    const empty: ResumePlan = { implementSessionId: null, implementSessionFile: null, skipImplement: false, skipChecks: false, allow, inheritedRounds: [], inheritedFixes: [], fixSessionId: null }
    const prior = yield* latestRunForBranch(db, run.projectDir, run.branch).pipe(
      Effect.mapError((cause) => historyFailure("read", cause))
    )
    if (prior === null || prior.id === run.runId) {
      return empty
    }
    const steps = yield* stepsForRun(db, prior.id).pipe(
      Effect.mapError((cause) => historyFailure("read", cause))
    )
    const implementPassed = steps.some((step) => step.name === "implement" && step.status === "passed")
    const checksPassed = steps.some((step) => step.name === "checks" && step.status === "passed")
    const sessionFiles: Array<string> = []
    for (const step of steps) {
      if (step.piSessionFile !== null) {
        sessionFiles.push(step.piSessionFile)
      }
    }
    const stored = sessionFiles.length === 0 ? null : (sessionFiles[sessionFiles.length - 1] ?? null)
    const source = stored ?? (yield* latestDiskSession(run, prior.id))
    const sessionId = sessionIdFromFile(source)
    let carriedFile: string | null = source
    if (source !== null && sessionId !== null) {
      const carried = yield* run.fs.readFileString(source).pipe(
        Effect.map((text) => text),
        Effect.orElseSucceed(() => null)
      )
      if (carried !== null) {
        const target = run.path.join(run.hostSessionsDir, "resumed", source.slice(source.lastIndexOf("/") + 1))
        yield* run.fs.makeDirectory(run.path.dirname(target), { recursive: true }).pipe(
          Effect.andThen(() => run.fs.writeFileString(target, carried)),
          Effect.orElseSucceed(() => undefined)
        )
        carriedFile = target
      }
    }
    const skipImplement = implementPassed
    const skipChecks = implementPassed && checksPassed
    const storedFixes = implementPassed
      ? yield* fixesForRun(db, prior.id).pipe(Effect.mapError((cause) => historyFailure("read", cause)))
      : []
    let fixSessionId: string | null = null
    for (const fix of storedFixes) {
      if (fix.sessionFile !== null) {
        fixSessionId = fix.sessionFile
      }
    }
    if (!skipChecks) {
      return { implementSessionId: sessionId, implementSessionFile: carriedFile, skipImplement, skipChecks, allow, inheritedRounds: [], inheritedFixes: [], fixSessionId }
    }
    const storedRounds = yield* checksRoundsForRun(db, prior.id).pipe(Effect.mapError((cause) => historyFailure("read", cause)))
    return {
      implementSessionId: sessionId,
      implementSessionFile: carriedFile,
      skipImplement,
      skipChecks,
      allow,
      inheritedRounds: storedRounds.filter((round) => round.file !== "").map((round) => ({ round: round.round, file: round.file, started: round.started, ended: round.ended, passed: round.passed, failed: round.checks.filter((check) => !check.passed).map((check) => check.name), checks: [...round.checks] })),
      inheritedFixes: storedFixes.filter((fix) => fix.evidenceIn !== "").map((fix) => ({ attempt: fix.attempt, status: fix.status === "passed" ? "passed" as const : "failed" as const, started: fix.started, ended: fix.ended, agentFile: fix.agentFile ?? run.fixer.path, sessionFile: fix.sessionFile, evidenceIn: fix.evidenceIn, commits: fix.commits, tokens: fix.inputTokens === null || fix.outputTokens === null ? null : { input: fix.inputTokens, output: fix.outputTokens } })),
      fixSessionId
    }
  })

export const runWithHistory = (db: Database, run: HistoryRun, ops: SandboxOps): Effect.Effect<OrcRunReport, OrcRunError> =>
  Effect.gen(function*() {
    const resume = yield* buildResumePlan(db, run)
    yield* recordRunStart(db, run)
    for (const round of resume.inheritedRounds) {
      yield* recordChecksDone(db, run.runId, round)
    }
    for (const fix of resume.inheritedFixes) {
      yield* recordFixDone(db, run.runId, fix)
    }
    const checkpoints: RunCheckpoints = {
      implementStart: (started) => recordImplementStart(db, run, started),
      implementDone: (outcome, started, ended) => recordImplementDone(db, run, { agentPath: run.agent.path, sessionFile: outcome.sessionFile, tokens: outcome.tokens, commits: outcome.commits, implementPassed: outcome.completed }, started, ended),
      checksRoundStart: (round, started) => recordChecksStart(db, run.runId, round, started),
      checksRoundDone: (round) => recordChecksDone(db, run.runId, round),
      fixStart: (attempt, started) => recordFixStart(db, run.runId, attempt, run.fixer.path, started),
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
