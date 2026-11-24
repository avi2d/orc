import { holdReleaseGuidance, holdReleaseWordsOf } from "../../entities/review-gate/index"
import { loopAnswerOf, loopGuidance } from "./loop-pause"
import type { ResumePlan } from "./run-ops"
import { workerAnswersOf, workerGuidance } from "./worker-question"

export const releaseGuidanceOf = (answers: Pick<ResumePlan, "answers">["answers"]): string | null => {
  const released = holdReleaseWordsOf(answers)
  return released.length === 0 ? null : holdReleaseGuidance(released)
}

const answerGuidanceOf = (answers: Pick<ResumePlan, "answers">["answers"]): string | null => {
  const loop = loopAnswerOf(answers)
  const worker = workerAnswersOf(answers)
  const released = releaseGuidanceOf(answers)
  const guidance = [...(loop?.kind === "continue" ? [loopGuidance(loop.words)] : []), ...(worker.length > 0 ? [workerGuidance(worker)] : []), ...(released === null ? [] : [released])]
  return guidance.length === 0 ? null : guidance.join("\n")
}

// A fresh fixer session never paused and never asked, so only the hold release is guidance it can act on.
export const freshFixOf = (plan: Pick<ResumePlan, "answers">): { readonly session: null; readonly guidance: string } | null => {
  const guidance = releaseGuidanceOf(plan.answers)
  return guidance === null ? null : { session: null, guidance }
}

export const resumedFix = (plan: Pick<ResumePlan, "fixSessionFile" | "answers">): { readonly session: string; readonly guidance: string | null } | null =>
  plan.fixSessionFile === null ? null : { session: plan.fixSessionFile, guidance: answerGuidanceOf(plan.answers) }
