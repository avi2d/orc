import type { Show, ShownStep } from "./guard"

export interface StepAgent {
  readonly model: string
  readonly thinking: string | null
}

export interface RunFacts {
  readonly implement: StepAgent | null
  readonly running: StepAgent | null
  readonly started: string | null
  readonly ended: string | null
}

const agentOf = (step: Pick<ShownStep, "model" | "thinking"> | undefined): StepAgent | null =>
  step === undefined || step.model === null ? null : { model: step.model, thinking: step.thinking }

export const runFacts = (shown: Pick<Show, "started" | "ended" | "steps">): RunFacts => ({
  implement: agentOf(shown.steps.find((step) => step.name === "implement")),
  running: agentOf(shown.steps.filter((step) => step.status === "running").at(-1)) ?? agentOf(shown.steps.filter((step) => step.model !== null).at(-1)),
  started: shown.started,
  ended: shown.ended
})

const piSteps: ReadonlySet<string> = new Set(["implement"])

export const opensTurns = (step: Pick<ShownStep, "name" | "piSessionFile">): boolean =>
  piSteps.has(step.name) || step.piSessionFile !== null

export const namedModels = (steps: ReadonlyArray<Pick<ShownStep, "id" | "name" | "model" | "thinking">>): ReadonlyMap<number, string> => {
  const runModel = agentOf(steps.find((step) => step.name === "implement"))?.model ?? null
  return new Map(steps.flatMap((step) => step.model === null || step.model === runModel ? [] : [[step.id, step.model] as const]))
}
