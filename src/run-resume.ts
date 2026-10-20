import type { Database } from "bun:sqlite"
import { Effect, FileSystem, Option } from "effect"
import { checksRoundsForRun, fixesForRun, type StoredFix } from "./history-resume"
import { sessionIdFromFile, type RunRecord } from "./run-history"
import { latestRunForBranch, stepsForRun } from "./history-resume"
import { historyFailure } from "./history-write"
import type { HistoryRun } from "./run-record"
import type { ResumePlan } from "./run-loop"
import { OrcRunError } from "./run-session"

const refuse = (message: string): Effect.Effect<never, OrcRunError> => Effect.fail(new OrcRunError({ message }))

export const resolveTaskFile = (
  db: Database,
  fs: FileSystem.FileSystem,
  branch: string,
  projectDir: string,
  supplied: string | null | undefined
): Effect.Effect<string, OrcRunError> =>
  Effect.gen(function*() {
    const prior = yield* latestRunForBranch(db, projectDir, branch).pipe(Effect.mapError((cause) => historyFailure("read", cause)))
    if (supplied === undefined || supplied === null) {
      if (prior === null) {
        return yield* refuse("orc: no previous run for branch " + branch + ", so pass a task file")
      }
      return prior.taskFile
    }
    if (prior !== null) {
      yield* refuseOnChangedIntent(db, fs, branch, prior, supplied)
    }
    return supplied
  })

const refuseOnChangedIntent = (
  db: Database,
  fs: FileSystem.FileSystem,
  branch: string,
  prior: RunRecord,
  supplied: string
): Effect.Effect<void, OrcRunError> =>
  Effect.gen(function*() {
    const steps = yield* stepsForRun(db, prior.id).pipe(Effect.mapError((cause) => historyFailure("read", cause)))
    if (!steps.some((step) => step.name === "implement" && step.status === "passed")) {
      return
    }
    const saved = yield* fs.readFileString(prior.taskFile).pipe(Effect.orElseSucceed(() => null))
    const current = yield* fs.readFileString(supplied).pipe(Effect.orElseSucceed(() => null))
    if (saved !== null && current !== null && saved !== current) {
      return yield* refuse("orc: the task file changed since branch " + branch + " passed a step, so resume refuses new intent with old progress")
    }
  })

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

interface PriorProgress {
  readonly priorId: string
  readonly implementPassed: boolean
  readonly checksPassed: boolean
  readonly source: string | null
  readonly sessionId: string | null
  readonly storedFixes: ReadonlyArray<StoredFix>
}

const readPriorProgress = (db: Database, run: HistoryRun, prior: RunRecord): Effect.Effect<PriorProgress, OrcRunError> =>
  Effect.gen(function*() {
    const steps = yield* stepsForRun(db, prior.id).pipe(Effect.mapError((cause) => historyFailure("read", cause)))
    const implementPassed = steps.some((step) => step.name === "implement" && step.status === "passed")
    const checksPassed = steps.some((step) => step.name === "checks" && step.status === "passed")
    const sessionFiles = steps.flatMap((step) => step.piSessionFile === null ? [] : [step.piSessionFile])
    const stored = sessionFiles.length === 0 ? null : (sessionFiles[sessionFiles.length - 1] ?? null)
    const source = stored ?? (yield* latestDiskSession(run, prior.id))
    const storedFixes = implementPassed
      ? yield* fixesForRun(db, prior.id).pipe(Effect.mapError((cause) => historyFailure("read", cause)))
      : []
    return { priorId: prior.id, implementPassed, checksPassed, source, sessionId: sessionIdFromFile(source), storedFixes }
  })

const carrySessionFile = (run: HistoryRun, source: string | null, sessionId: string | null): Effect.Effect<string | null, OrcRunError> =>
  Effect.gen(function*() {
    if (source === null || sessionId === null) {
      return source
    }
    const carried = yield* run.fs.readFileString(source).pipe(
      Effect.map((text) => text),
      Effect.orElseSucceed(() => null)
    )
    if (carried === null) {
      return source
    }
    const target = run.path.join(run.hostSessionsDir, "resumed", source.slice(source.lastIndexOf("/") + 1))
    yield* run.fs.makeDirectory(run.path.dirname(target), { recursive: true }).pipe(
      Effect.andThen(() => run.fs.writeFileString(target, carried)),
      Effect.orElseSucceed(() => undefined)
    )
    return target
  })

const fixSessionFor = (storedFixes: ReadonlyArray<StoredFix>): string | null => {
  let fixSessionId: string | null = null
  for (const fix of storedFixes) {
    if (fix.sessionFile !== null) {
      fixSessionId = fix.sessionFile
    }
  }
  return fixSessionId
}

const inheritedCompletion = (
  db: Database,
  run: HistoryRun,
  priorId: string,
  storedFixes: ReadonlyArray<StoredFix>
): Effect.Effect<Pick<ResumePlan, "inheritedRounds" | "inheritedFixes">, OrcRunError> =>
  Effect.gen(function*() {
    const storedRounds = yield* checksRoundsForRun(db, priorId).pipe(Effect.mapError((cause) => historyFailure("read", cause)))
    return {
      inheritedRounds: storedRounds.filter((round) => round.file !== "").map((round) => ({
        round: round.round,
        file: round.file,
        started: round.started,
        ended: round.ended,
        passed: round.passed,
        failed: round.checks.filter((check) => !check.passed).map((check) => check.name),
        checks: [...round.checks]
      })),
      inheritedFixes: storedFixes.filter((fix) => fix.evidenceIn !== "").map((fix) => ({
        attempt: fix.attempt,
        status: fix.status === "passed" ? "passed" as const : "failed" as const,
        started: fix.started,
        ended: fix.ended,
        agentFile: fix.agentFile ?? run.fixer.path,
        sessionFile: fix.sessionFile,
        evidenceIn: fix.evidenceIn,
        commits: fix.commits,
        tokens: fix.inputTokens === null || fix.outputTokens === null ? null : { input: fix.inputTokens, output: fix.outputTokens }
      }))
    }
  })

export const buildResumePlan = (db: Database, run: HistoryRun): Effect.Effect<ResumePlan, OrcRunError> =>
  Effect.gen(function*() {
    const allow = run.allow ?? false
    const empty: ResumePlan = { implementSessionId: null, implementSessionFile: null, skipImplement: false, skipChecks: false, allow, inheritedRounds: [], inheritedFixes: [], fixSessionId: null }
    const prior = yield* latestRunForBranch(db, run.projectDir, run.branch).pipe(
      Effect.mapError((cause) => historyFailure("read", cause))
    )
    if (prior === null || prior.id === run.runId) {
      return empty
    }
    const progress = yield* readPriorProgress(db, run, prior)
    const carriedFile = yield* carrySessionFile(run, progress.source, progress.sessionId)
    const skipImplement = progress.implementPassed
    const skipChecks = progress.implementPassed && progress.checksPassed
    const fixSessionId = fixSessionFor(progress.storedFixes)
    if (!skipChecks) {
      return { implementSessionId: progress.sessionId, implementSessionFile: carriedFile, skipImplement, skipChecks, allow, inheritedRounds: [], inheritedFixes: [], fixSessionId }
    }
    const inherited = yield* inheritedCompletion(db, run, progress.priorId, progress.storedFixes)
    return {
      implementSessionId: progress.sessionId,
      implementSessionFile: carriedFile,
      skipImplement,
      skipChecks,
      allow,
      inheritedRounds: inherited.inheritedRounds,
      inheritedFixes: inherited.inheritedFixes,
      fixSessionId
    }
  })
