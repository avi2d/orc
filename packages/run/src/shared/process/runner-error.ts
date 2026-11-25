import { Data } from "effect"

export class RunnerError extends Data.TaggedError("RunnerError")<{
  readonly detail: string
}> {}

export class MachineUnreached extends Data.TaggedError("MachineUnreached")<{
  readonly detail: string
}> {}
