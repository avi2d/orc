import type { ShownStep } from "./guard"

export interface RunAgent {
  readonly model: string | null
  readonly effort: string | null
}

export const runAgent = (steps: ReadonlyArray<Pick<ShownStep, "name" | "model" | "thinking">>): RunAgent | null => {
  const agent = steps.find((step) => step.name === "implement")
  return agent === undefined ? null : { model: agent.model, effort: agent.thinking }
}

const piSteps: ReadonlySet<string> = new Set(["implement"])

export const opensTurns = (step: Pick<ShownStep, "name" | "piSessionFile">): boolean =>
  piSteps.has(step.name) || step.piSessionFile !== null

export const agentLabel = (agent: RunAgent | null): string | null => {
  const words = agent === null ? [] : [agent.model, agent.effort].filter((word) => word !== null)
  return words.length === 0 ? null : words.join(" ")
}

export const cardPlace = (card: { readonly where: string }, agent: RunAgent | null): string => {
  const label = agentLabel(agent)
  return label === null ? card.where : `${label} · ${card.where}`
}

export const namedModels = (steps: ReadonlyArray<Pick<ShownStep, "id" | "name" | "model" | "thinking">>): ReadonlyMap<number, string> => {
  const runModel = runAgent(steps)?.model ?? null
  return new Map(steps.flatMap((step) => step.model === null || step.model === runModel ? [] : [[step.id, step.model] as const]))
}
