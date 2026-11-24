import { Data } from "effect"

export const ciOnlyTestsEnv = { HEAVY_TESTS_CI_ONLY: "1" } as const

export const workerCiInstructions = [
  "Leave repository tests to GitHub CI.",
  "Do not run them locally.",
  "You may run build, lint, or typecheck.",
  "If a pull request run exists, do not start or rerun CI by hand.",
  "Do not wait for CI in a tool call."
].join(" ")

export class OrcRunError extends Data.TaggedError("OrcRunError")<{
  readonly message: string
}> {}
