import type { Database } from "bun:sqlite"
import { Effect, FileSystem, Option, Schema } from "effect"
import { defaultSandbox, type SandboxKind } from "./args"
import { checksRoundsForRun, fixesForRun, type StoredFix } from "./history-resume"
import { sessionIdFromFile, type RunRecord } from "./run-history"
import { latestRunForBranch, stepsForRun } from "./history-resume"
import { historyFailure } from "./history-write"
import type { HistoryRun } from "./run-record"
import type { ResumePlan } from "./run-loop"
import { handoverFileName } from "./long-session"
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

export const resolveSandboxKind = (
  db: Database,
  branch: string,
  projectDir: string,
  flag: SandboxKind | undefined
): Effect.Effect<SandboxKind, OrcRunError> =>
  Effect.gen(function*() {
    const prior = yield* latestRunForBranch(db, projectDir, branch).pipe(Effect.mapError((cause) => historyFailure("read", cause)))
    const recorded = prior?.sandbox ?? null
    if (recorded === null) {
      return flag ?? defaultSandbox
    }
    if (flag !== undefined && flag !== recorded) {
      return yield* refuse("orc: branch " + branch + " started with --sandbox " + recorded + ", so resume refuses --sandbox " + flag + "; drop --sandbox to resume with " + recorded)
    }
    return recorded
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
    if (steps.length === 0) {
      return
    }
    const saved = yield* fs.readFileString(prior.taskFile).pipe(Effect.orElseSucceed(() => null))
    const current = yield* fs.readFileString(supplied).pipe(Effect.orElseSucceed(() => null))
    if (saved === null || current === null) {
      return yield* refuse("orc: the saved task for branch " + branch + " cannot be read, so resume refuses to reuse its progress with new intent")
    }
    if (saved !== current) {
      return yield* refuse("orc: the task file changed since branch " + branch + " recorded progress, so resume refuses new intent with old progress")
    }
  })

const latestSessionFile = (run: HistoryRun, dirs: ReadonlyArray<string>): Effect.Effect<string | null, OrcRunError> =>
  Effect.gen(function*() {
    const found: Array<{ readonly file: string; readonly mtime: number }> = []
    for (const dir of dirs) {
      const top = yield* run.fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
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
  readonly implementSource: string | null
  readonly implementSessionId: string | null
  readonly fixSource: string | null
  readonly fixSessionId: string | null
  readonly fixRunning: boolean
  readonly storedFixes: ReadonlyArray<StoredFix>
}

const readPriorProgress = (db: Database, run: HistoryRun, prior: RunRecord): Effect.Effect<PriorProgress, OrcRunError> =>
  Effect.gen(function*() {
    const steps = yield* stepsForRun(db, prior.id).pipe(Effect.mapError((cause) => historyFailure("read", cause)))
    const implementSteps = steps.filter((step) => step.name === "implement")
    const implementPassed = implementSteps.some((step) => step.status === "passed")
    const checksPassed = steps.some((step) => step.name === "checks" && step.status === "passed")
    const implementFile = implementSteps.flatMap((step) => step.piSessionFile === null ? [] : [step.piSessionFile]).at(-1) ?? null
    const interruptedImplement = implementSteps.some((step) => step.status === "running")
    const interruptedFix = steps.some((step) => step.name === "fix" && step.status === "running")
    const priorDir = run.path.join(run.path.dirname(run.runDir), prior.id)
    const liveFile = interruptedImplement || interruptedFix
      ? yield* latestSessionFile(run, [run.path.join(priorDir, "session", "agent", "sessions"), run.path.join(priorDir, "sessions")])
      : null
    const implementSource = interruptedImplement
      ? (liveFile ?? implementFile)
      : (implementFile ?? (yield* latestSessionFile(run, [run.path.join(priorDir, "sessions")])))
    const implementSessionId = sessionIdFromFile(implementSource)
    const storedFixes = implementPassed
      ? yield* fixesForRun(db, prior.id).pipe(Effect.mapError((cause) => historyFailure("read", cause)))
      : []
    const storedFixFile = storedFixes.flatMap((fix) => fix.sessionFile === null ? [] : [fix.sessionFile]).at(-1) ?? null
    const liveFixId = interruptedFix && liveFile !== null && sessionIdFromFile(liveFile) !== implementSessionId
      ? sessionIdFromFile(liveFile)
      : null
    const fixSource = liveFixId !== null ? liveFile : storedFixFile
    return { priorId: prior.id, implementPassed, checksPassed, implementSource, implementSessionId, fixSource, fixSessionId: liveFixId ?? sessionIdFromFile(storedFixFile), fixRunning: interruptedFix, storedFixes }
  })

const decodeJsonLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const pointLineAt = (line: string, cwd: string): string => {
  if (line === "") {
    return line
  }
  const parsed = decodeJsonLine(line)
  if (Option.isNone(parsed) || !isRecord(parsed.value)) {
    return line
  }
  const entry = parsed.value
  if (entry["type"] !== "session" || entry["cwd"] === cwd) {
    return line
  }
  return JSON.stringify({ ...entry, cwd })
}

const pointSessionAt = (text: string, cwd: string): string =>
  text.split("\n").map((line) => pointLineAt(line, cwd)).join("\n")

const carrySessionFile = (run: HistoryRun, source: string | null, sessionId: string | null): Effect.Effect<string | null, OrcRunError> =>
  Effect.gen(function*() {
    if (source === null || sessionId === null) {
      return null
    }
    const carried = yield* run.fs.readFileString(source).pipe(
      Effect.map((text) => text),
      Effect.orElseSucceed(() => null)
    )
    if (carried === null) {
      return source
    }
    const target = run.path.join(run.hostSessionsDir, "host", source.slice(source.lastIndexOf("/") + 1))
    yield* run.fs.makeDirectory(run.path.dirname(target), { recursive: true }).pipe(
      Effect.andThen(() => run.fs.writeFileString(target, pointSessionAt(carried, run.worktreeDir))),
      Effect.orElseSucceed(() => undefined)
    )
    return target
  })

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
    const allow = run.allow ?? []
    const answers = run.answers ?? []
    const empty: ResumePlan = { implementSessionId: null, implementSessionFile: null, skipImplement: false, skipChecks: false, allow, answers, inheritedRounds: [], inheritedFixes: [], fixSessionId: null, fixSessionFile: null, fixRunning: false, handover: null }
    const prior = yield* latestRunForBranch(db, run.projectDir, run.branch).pipe(
      Effect.mapError((cause) => historyFailure("read", cause))
    )
    if (prior === null || prior.id === run.runId) {
      return empty
    }
    const progress = yield* readPriorProgress(db, run, prior)
    const carriedImplement = yield* carrySessionFile(run, progress.implementSource, progress.implementSessionId)
    const carriedFix = yield* carrySessionFile(run, progress.fixSource, progress.fixSessionId)
    const skipImplement = progress.implementPassed
    const skipChecks = progress.implementPassed && progress.checksPassed
    const inherited = progress.implementPassed
      ? yield* inheritedCompletion(db, run, progress.priorId, progress.storedFixes)
      : { inheritedRounds: [], inheritedFixes: [] }
    const handover = yield* run.fs.readFileString(run.path.join(run.path.dirname(run.runDir), prior.id, handoverFileName)).pipe(
      Effect.orElseSucceed(() => null)
    )
    return {
      implementSessionId: progress.implementSessionId,
      implementSessionFile: carriedImplement,
      skipImplement,
      skipChecks,
      allow,
      answers,
      inheritedRounds: inherited.inheritedRounds,
      inheritedFixes: inherited.inheritedFixes,
      fixSessionId: progress.fixSessionId,
      fixSessionFile: carriedFix,
      fixRunning: progress.fixRunning,
      handover
    }
  })
