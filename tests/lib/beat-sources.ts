import { Effect } from "effect"
import type { BeatSources } from "../../packages/run/src/dispatch/beat"
import { BacklogError } from "../../packages/run/src/dispatch/backlog-write"
import { type ReadLoad, readMachineLoad } from "../../packages/run/src/dispatch/load"
import type { PullRequestView } from "../../packages/run/src/dispatch/pr-view"
import type { ReadPullRequest } from "../../packages/run/src/dispatch/task-events"
import type { ReadUpstream } from "../../packages/run/src/dispatch/upstream"
import type { AskDecider } from "../../packages/run/src/dispatch/decider"

export const uncheckedOpen: PullRequestView = { state: "OPEN", headRefOid: "0".repeat(40), baseRefName: "main", statusCheckRollup: [] }

const noUpstream: ReadUpstream = (contribution) => Effect.fail(new BacklogError({ detail: "no upstream read for " + contribution.url + " in this test" }))

const escalateAll: AskDecider = () => Effect.succeed(JSON.stringify({ decision: "escalate", reason: "no decider in this test" }))

export const quietSources = (
  readLoad: ReadLoad = readMachineLoad,
  readPullRequest: ReadPullRequest = () => Effect.succeed(uncheckedOpen),
  readUpstream: ReadUpstream = noUpstream,
  askDecider: AskDecider = escalateAll
): BeatSources => ({
  readLoad,
  readPullRequest,
  readUpstream,
  askDecider
})
