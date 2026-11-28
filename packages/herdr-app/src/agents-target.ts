import { type Card, lastTab, recordedStatus } from "./agents"
import type { Chosen } from "./agents-view"
import type { ShownStep } from "./guard"

const openingStep = (card: Card, steps: ReadonlyArray<ShownStep>): Chosen | null => {
  const failed = card.standing.status === "Failed" ? steps.filter((step) => recordedStatus(step.status, card.standing.status) === "failed").at(-1) : undefined
  const step = failed ?? steps.at(-1)
  return step === undefined ? null : { kind: "step", id: step.id }
}

export const targetOf = (card: Card, chosen: Chosen | null, steps: ReadonlyArray<ShownStep>): Chosen | null => {
  if (chosen?.kind === "thread") return chosen
  if (chosen?.kind === "approve" && lastTab(card) !== null) return chosen
  if (chosen?.kind === "step" && steps.some((step) => step.id === chosen.id)) return chosen
  if (card.standing.status === "Awaiting you") return card.standing.waiting.on === "approval" ? { kind: "approve" } : { kind: "thread" }
  if (card.runId === null) return { kind: "thread" }
  if (card.standing.status === "Done" && lastTab(card) !== null) return { kind: "approve" }
  return openingStep(card, steps)
}
