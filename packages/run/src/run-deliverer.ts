import type { RunDelivery } from "./shared/config/index"
import { subprocessPullRequestOpener } from "./entities/pull-request/index"
import { subprocessNoMistakesRunner, type SubprocessRunnerOptions } from "./entities/review-gate/index"
import type { RunDeliverer } from "./run-record"

export const subprocessDeliverer = (delivery: RunDelivery, host: SubprocessRunnerOptions & { readonly branch: string }): RunDeliverer =>
  delivery === "direct-PR"
    ? { kind: "direct-PR", opener: subprocessPullRequestOpener({ ...host, gh: "gh" }) }
    : { kind: "no-mistakes", runner: subprocessNoMistakesRunner(host) }
