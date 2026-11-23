import { Data } from "effect"

export const ciOnlyTestsInstruction = "Leave repository tests to GitHub CI. Do not run them locally. You may run build, lint, or typecheck."

export class OrcRunError extends Data.TaggedError("OrcRunError")<{
  readonly message: string
}> {}
