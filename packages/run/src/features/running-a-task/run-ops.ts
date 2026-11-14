import type { Effect } from "effect"
import type { AgentFile, PiRun, PiTokenUse, LongSessionCounts } from "../../entities/agent/index"
import type { CommandResult } from "../../shared/sandbox/index"
import type { OrcRunError } from "../../shared/lib/index"
import type { AllowWord, NoMistakesRecord, OpenQuestion, QuestionAnswer } from "../../entities/review-gate/index"
import type { DirectPrRecord } from "../../entities/pull-request/index"
import type { ChecksRoundSummary, OrcRunCommit, RecordedFixAttempt } from "./run-record"

export interface AgentRun {
  readonly agent: AgentFile
  readonly prompt: string
  readonly logFile: string
  readonly resumeSession: string | null
  readonly onSession: (file: string) => Effect.Effect<void, OrcRunError>
}

export interface AgentRunResult extends PiRun {
  readonly commits: ReadonlyArray<{ readonly sha: string }>
}

export interface SandboxOps {
  readonly runAgent: (run: AgentRun) => Effect.Effect<AgentRunResult, OrcRunError>
  readonly execCheck: (command: string) => Effect.Effect<CommandResult, OrcRunError>
}

export interface ResumePlan {
  readonly implementSessionId: string | null
  readonly implementSessionFile: string | null
  readonly inheritedImplement: { readonly agentFile: string | null; readonly model: string | null; readonly thinking: string | null } | null
  readonly skipImplement: boolean
  readonly skipChecks: boolean
  readonly allow: ReadonlyArray<AllowWord>
  readonly answers: ReadonlyArray<QuestionAnswer>
  readonly inheritedRounds: ReadonlyArray<ChecksRoundSummary>
  readonly inheritedFixes: ReadonlyArray<RecordedFixAttempt>
  readonly fixSessionId: string | null
  readonly fixSessionFile: string | null
  readonly fixRunning: boolean
  readonly handover: string | null
  readonly priorDir: string | null
}

export interface AgentOutcome {
  readonly sessionId: string | null
  readonly sessionFile: string | null
  readonly commits: Array<OrcRunCommit>
  readonly tokens: PiTokenUse | null
  readonly sessionSize: LongSessionCounts | null
  readonly completed: boolean
  readonly markerVerified: boolean
  readonly endReason: string
}

export interface RunCheckpoints {
  readonly implementStart: (started: string) => Effect.Effect<void, OrcRunError>
  readonly implementSession: (file: string) => Effect.Effect<void, OrcRunError>
  readonly implementDone: (outcome: AgentOutcome, started: string, ended: string) => Effect.Effect<void, OrcRunError>
  readonly checksRoundStart: (round: number, started: string) => Effect.Effect<void, OrcRunError>
  readonly checksRoundDone: (round: ChecksRoundSummary) => Effect.Effect<void, OrcRunError>
  readonly fixStart: (attempt: number, started: string) => Effect.Effect<void, OrcRunError>
  readonly fixSession: (attempt: number, file: string) => Effect.Effect<void, OrcRunError>
  readonly fixDone: (fix: RecordedFixAttempt) => Effect.Effect<void, OrcRunError>
  readonly noMistakesStart: (started: string) => Effect.Effect<void, OrcRunError>
  readonly noMistakesDone: (record: NoMistakesRecord) => Effect.Effect<void, OrcRunError>
  readonly pullRequestStart: (started: string) => Effect.Effect<void, OrcRunError>
  readonly pullRequestDone: (record: DirectPrRecord) => Effect.Effect<void, OrcRunError>
  readonly loopAsked: (step: AgentStep, question: OpenQuestion) => Effect.Effect<void, OrcRunError>
}

export type AgentStep = { readonly name: "implement"; readonly attempt: 1 } | { readonly name: "fix"; readonly attempt: number }
