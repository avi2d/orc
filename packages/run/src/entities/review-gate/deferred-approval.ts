import { Effect, FileSystem } from "effect"
import { scalar } from "../../shared/lib/index"
import { omittedQuestionIds, openQuestionsIn, type ParkedGate, type ParsedRun } from "./no-mistakes-gate"
import { settleFixResponse, type NoMistakesReply } from "./no-mistakes-response"
import type { DriveLog } from "./no-mistakes-drive-log"
import type { NoMistakesInput } from "./no-mistakes"

export const canDeferFindings = (gate: ParkedGate, parsed: ParsedRun, stdout: string): boolean =>
  gate.step === "review" && gate.stage === "fix-review" && scalar(stdout, "defer_non_errors") === "true" &&
  openQuestionsIn(parsed.findings, omittedQuestionIds(stdout)).length === 0 && parsed.findings.length > 0 &&
  parsed.findings.every((finding) => finding.id !== "" && (finding.severity === "warning" || finding.severity === "info"))

export const approveFollowUps = (
  input: NoMistakesInput,
  log: DriveLog,
  supplied: Map<string, string>,
  parsed: ParsedRun
): Effect.Effect<NoMistakesReply, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const reply = yield* input.runner.respond({ kind: "approve", followUps: parsed.findings.map((finding) => finding.id) })
    yield* settleFixResponse(input.runDir, log, supplied, [], reply)
    return reply
  })
