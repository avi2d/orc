import { Effect, Option } from "effect"
import type { BeatSources } from "../../packages/run/src/widgets/beat/beat"
import { BacklogError } from "../../packages/run/src/entities/backlog/index"
import { type ReadLoad, readMachineLoad } from "../../packages/run/src/widgets/beat/load"
import type { PullRequestView } from "../../packages/run/src/entities/pull-request/pr-view"
import type { ReadPullRequest } from "../../packages/run/src/widgets/beat/task-events"
import type { ReadUpstream } from "../../packages/run/src/widgets/beat/upstream"
import type { AskDecider } from "../../packages/run/src/features/decider/index"
import type { ReadBaseCi } from "../../packages/run/src/features/merging-a-pr/index"

export const uncheckedOpen: PullRequestView = { state: "OPEN", headRefOid: "0".repeat(40), baseRefName: "main", statusCheckRollup: [] }

const noUpstream: ReadUpstream = (contribution) => Effect.fail(new BacklogError({ detail: "no upstream read for " + contribution.url + " in this test" }))

const escalateAll: AskDecider = { home: "/nonexistent/orc-home", ask: () => Effect.succeed(JSON.stringify({ decision: "escalate", reason: "no decider in this test" })) }

const noBaseCi: ReadBaseCi = { remote: () => Effect.succeed(Option.none()), repositories: () => Effect.succeed(Option.none()) }

export const quietSources = (
  readLoad: ReadLoad = readMachineLoad,
  readPullRequest: ReadPullRequest = () => Effect.succeed(uncheckedOpen),
  readUpstream: ReadUpstream = noUpstream,
  askDecider: AskDecider = escalateAll
): BeatSources => ({
  update: null,
  readLoad,
  readPullRequest,
  readUpstream,
  askDecider,
  readBaseCi: noBaseCi
})
