import { Effect } from "effect"
import type { BeatSources } from "../../packages/run/src/dispatch/beat"
import { type ReadLoad, readMachineLoad } from "../../packages/run/src/dispatch/load"
import type { PullRequestView } from "../../packages/run/src/dispatch/pr-view"
import type { ReadPullRequest } from "../../packages/run/src/dispatch/task-events"

export const uncheckedOpen: PullRequestView = { state: "OPEN", headRefOid: "0".repeat(40), baseRefName: "main", statusCheckRollup: [] }

export const quietSources = (readLoad: ReadLoad = readMachineLoad, readPullRequest: ReadPullRequest = () => Effect.succeed(uncheckedOpen)): BeatSources => ({
  readLoad,
  readPullRequest,
  alerts: null
})
