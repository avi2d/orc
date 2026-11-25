import type { AgentFile } from "../../entities/agent/index"
import { subprocessPullRequestOpener } from "../../entities/pull-request/index"
import { subprocessNoMistakesRunner, type SubprocessRunnerOptions } from "../../entities/review-gate/index"
import type { RunDeliverer } from "./run-record"

export type PreparedReviewer =
  | { readonly kind: "direct-PR"; readonly reviewer: AgentFile }
  | { readonly kind: "no-mistakes" }
  | { readonly kind: "orc" }

export const subprocessDeliverer = (host: SubprocessRunnerOptions & { readonly branch: string }, prepared: PreparedReviewer): RunDeliverer =>
  prepared.kind === "direct-PR"
    ? { kind: "direct-PR", opener: subprocessPullRequestOpener({ ...host, gh: "gh" }), reviewer: prepared.reviewer }
    : prepared.kind === "orc"
      ? { kind: "orc", opener: subprocessPullRequestOpener({ ...host, gh: "gh" }) }
      : { kind: "no-mistakes", runner: subprocessNoMistakesRunner(host) }
