import type { RunDelivery } from "./delivery"
import { subprocessPullRequestOpener } from "./direct-pr"
import { subprocessNoMistakesRunner, type SubprocessRunnerOptions } from "./no-mistakes"
import type { RunDeliverer } from "./run-record"

export const subprocessDeliverer = (delivery: RunDelivery, host: SubprocessRunnerOptions & { readonly branch: string }): RunDeliverer =>
  delivery === "direct-PR"
    ? { kind: "direct-PR", opener: subprocessPullRequestOpener({ ...host, gh: "gh" }) }
    : { kind: "no-mistakes", runner: subprocessNoMistakesRunner(host) }
