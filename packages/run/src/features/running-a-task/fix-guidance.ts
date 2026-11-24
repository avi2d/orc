import { holdReleaseGuidance, holdReleaseWordsOf } from "../../entities/review-gate/index"
import { loopAnswerOf, loopGuidance } from "./loop-pause"
import type { ResumePlan } from "./run-ops"
import { workerAnswersOf, workerGuidance } from "./worker-question"

const answerGuidanceOf = (answers: Pick<ResumePlan, "answers">["answers"]): string | null => {
  const loop = loopAnswerOf(answers)
  const worker = workerAnswersOf(answers)
  const released = holdReleaseWordsOf(answers)
  const guidance = [...(loop?.kind === "continue" ? [loopGuidance(loop.words)] : []), ...(worker.length > 0 ? [workerGuidance(worker)] : []), ...(released.length === 0 ? [] : [holdReleaseGuidance(released)])]
  return guidance.length === 0 ? null : guidance.join("\n")
}

export const freshFixOf = (plan: Pick<ResumePlan, "answers">): { readonly session: null; readonly guidance: string } | null => {
  const guidance = answerGuidanceOf(plan.answers)
  return guidance === null ? null : { session: null, guidance }
}

export const resumedFix = (plan: Pick<ResumePlan, "fixSessionFile" | "answers">): { readonly session: string; readonly guidance: string | null } | null =>
  plan.fixSessionFile === null ? null : { session: plan.fixSessionFile, guidance: answerGuidanceOf(plan.answers) }
