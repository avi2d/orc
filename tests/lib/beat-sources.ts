import { Effect } from "effect"
import type { BeatSources } from "../../packages/run/src/dispatch/beat"
import { BacklogError } from "../../packages/run/src/dispatch/backlog-write"
import { type ReadLoad, readMachineLoad } from "../../packages/run/src/dispatch/load"
import type { PullRequestView } from "../../packages/run/src/dispatch/pr-view"
import type { ReadPullRequest } from "../../packages/run/src/dispatch/task-events"
import type { ReadUpstream } from "../../packages/run/src/dispatch/upstream"

export const uncheckedOpen: PullRequestView = { state: "OPEN", headRefOid: "0".repeat(40), baseRefName: "main", statusCheckRollup: [] }

const noUpstream: ReadUpstream = (contribution) => Effect.fail(new BacklogError({ detail: "no upstream read for " + contribution.url + " in this test" }))

export const quietSources = (
  readLoad: ReadLoad = readMachineLoad,
  readPullRequest: ReadPullRequest = () => Effect.succeed(uncheckedOpen),
  readUpstream: ReadUpstream = noUpstream
): BeatSources => ({
  readLoad,
  readPullRequest,
  readUpstream
})
