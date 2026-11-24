import { Data } from "effect"

export const ciOnlyTestsEnv = { HEAVY_TESTS_CI_ONLY: "1" } as const

export const ciOnlyTestsInstruction = "Leave repository tests to GitHub CI. Do not run them locally. You may run build, lint, or typecheck."

export class OrcRunError extends Data.TaggedError("OrcRunError")<{
  readonly message: string
}> {}
