import { Effect, FileSystem } from "effect"
import { scalar } from "../../shared/lib/index"
import { omittedQuestionIds, openQuestionsIn, type GateResponse, type ParkedGate, type ParsedRun } from "./no-mistakes-gate"
import { settleFixResponse, type NoMistakesReply } from "./no-mistakes-response"
import type { DriveLog } from "./no-mistakes-drive-log"
import type { QuestionAnswer } from "./question"

export const canDeferFindings = (gate: ParkedGate, parsed: ParsedRun, stdout: string): boolean =>
  gate.step === "review" && gate.stage === "fix-review" && scalar(stdout, "defer_non_errors") === "true" &&
  openQuestionsIn(parsed.findings, omittedQuestionIds(stdout)).length === 0 && parsed.findings.length > 0 &&
  parsed.findings.every((finding) => finding.id !== "" && (finding.severity === "warning" || finding.severity === "info"))

export const approveFollowUps = (
  input: { readonly runDir: string; readonly runner: { readonly respond: (response: GateResponse) => Effect.Effect<NoMistakesReply> } },
  log: DriveLog,
  supplied: Map<string, QuestionAnswer>,
  parsed: ParsedRun,
  gate: ParkedGate
): Effect.Effect<{ readonly kind: "next"; readonly current: NoMistakesReply; readonly sent: { readonly kind: "respond"; readonly gate: ParkedGate } }, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const reply = yield* input.runner.respond({ kind: "approve", followUps: parsed.findings.map((finding) => finding.id) })
    yield* settleFixResponse(input.runDir, log, supplied, [], reply)
    return { kind: "next", current: reply, sent: { kind: "respond", gate } }
  })
