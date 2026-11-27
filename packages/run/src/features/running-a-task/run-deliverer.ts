import { Array as Arr, Console, Effect } from "effect"
import type { AgentFile } from "../../entities/agent/index"
import { subprocessPullRequestOpener } from "../../entities/pull-request/index"
import { subprocessNoMistakesRunner, type SubprocessRunnerOptions } from "../../entities/review-gate/index"
import type { DefaultCredential, ReviewerEntry, RoomReading } from "../../shared/config/index"
import type { OrcRunError } from "../../shared/lib/index"
import { chosenReviewerLine, type NoReviewerRoom, pickChainEntry, ReviewerRoomWait } from "./reviewer-chain"
import type { ReviewerPick, SandboxOps } from "./run-ops"
import type { RunDeliverer } from "./run-record"

export interface ChainReviewer extends ReviewerEntry {
  readonly reviewer: AgentFile
  readonly credential: DefaultCredential
}

export type PreparedReviewer =
  | { readonly kind: "direct-PR"; readonly reviewer: AgentFile }
  | { readonly kind: "no-mistakes" }
  | { readonly kind: "orc"; readonly reviewer: AgentFile }
  | { readonly kind: "orc-chain"; readonly chain: Arr.NonEmptyReadonlyArray<ChainReviewer> }

export const fixedReviewer = (reviewer: AgentFile): ReviewerPick => (runAgent) => Effect.succeed({ reviewer, runAgent })

export interface ReviewerChainOptions {
  readonly chain: Arr.NonEmptyReadonlyArray<ChainReviewer>
  readonly implementerProvider: string
  readonly readRoom: Effect.Effect<RoomReading>
  readonly openReviewer: (entry: ChainReviewer, position: number) => Effect.Effect<SandboxOps["runAgent"], OrcRunError>
}

// Only an entry off the implementer's provider can ever review, so a chain without one has nothing to wait for.
const waitForRoom = (options: ReviewerChainOptions, error: NoReviewerRoom): Effect.Effect<never, NoReviewerRoom | ReviewerRoomWait> => {
  const reviewers = options.chain
    .filter((entry) => entry.provider !== options.implementerProvider)
    .map(({ provider, model, credential }) => ({ provider, model, credential }))
  return Arr.isReadonlyArrayNonEmpty(reviewers)
    ? Effect.fail(new ReviewerRoomWait({ wait: { reason: error.message, reviewers } }))
    : Effect.fail(error)
}

export const chainReviewer = (options: ReviewerChainOptions): ReviewerPick => {
  const opened = new Map<number, SandboxOps["runAgent"]>()
  return () =>
    Effect.gen(function*() {
      const roomOf = yield* options.readRoom
      const pick = yield* pickChainEntry(options.chain, options.implementerProvider, roomOf).pipe(
        Effect.catchTag("NoReviewerRoom", (error) => waitForRoom(options, error))
      )
      yield* Console.log(chosenReviewerLine(pick))
      const runAgent = opened.get(pick.position) ?? (yield* options.openReviewer(pick.entry, pick.position))
      opened.set(pick.position, runAgent)
      return { reviewer: pick.entry.reviewer, runAgent }
    })
}

export const subprocessDeliverer = (host: SubprocessRunnerOptions & { readonly branch: string; readonly maxFixRounds: number }, prepared: PreparedReviewer, pickChain: (chain: Arr.NonEmptyReadonlyArray<ChainReviewer>) => ReviewerPick): RunDeliverer => {
  switch (prepared.kind) {
    case "direct-PR":
      return { kind: "direct-PR", opener: subprocessPullRequestOpener({ ...host, gh: "gh" }), reviewer: prepared.reviewer }
    case "orc":
      return { kind: "orc", opener: subprocessPullRequestOpener({ ...host, gh: "gh" }), reviewer: fixedReviewer(prepared.reviewer), maxFixRounds: host.maxFixRounds }
    case "orc-chain":
      return { kind: "orc", opener: subprocessPullRequestOpener({ ...host, gh: "gh" }), reviewer: pickChain(prepared.chain), maxFixRounds: host.maxFixRounds }
    case "no-mistakes":
      return { kind: "no-mistakes", runner: subprocessNoMistakesRunner(host) }
  }
}
