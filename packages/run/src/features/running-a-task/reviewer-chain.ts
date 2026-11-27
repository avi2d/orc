import { type Array as Arr, Effect, Schema } from "effect"
import type { ProviderRoom, ReviewerEntry } from "../../shared/config/index"

export class NoReviewerRoom extends Schema.TaggedError<NoReviewerRoom>()("NoReviewerRoom", {
  message: Schema.String
}) {}

export interface PassedEntry {
  readonly entry: ReviewerEntry
  readonly reason: string
}

export interface ChainPick<T extends ReviewerEntry> {
  readonly entry: T
  readonly position: number
  readonly passed: ReadonlyArray<PassedEntry>
}

const passedText = (passed: ReadonlyArray<PassedEntry>): string =>
  passed.map(({ entry, reason }) => entry.model + " (" + reason + ")").join("; ")

export const pickChainEntry = <T extends ReviewerEntry, R>(
  chain: Arr.NonEmptyReadonlyArray<T>,
  implementerProvider: string,
  readRoom: (provider: string) => Effect.Effect<ProviderRoom, never, R>
): Effect.Effect<ChainPick<T>, NoReviewerRoom, R> =>
  Effect.gen(function*() {
    const passed: Array<PassedEntry> = []
    for (const [index, entry] of chain.entries()) {
      if (entry.provider === implementerProvider) {
        passed.push({ entry, reason: "the implementer runs on " + implementerProvider })
        continue
      }
      const room = yield* readRoom(entry.provider)
      if (room.kind === "room") {
        return { entry, position: index + 1, passed }
      }
      passed.push({ entry, reason: room.reason })
    }
    return yield* Effect.fail(new NoReviewerRoom({
      message: "no reviewer in the chain has quota room on a provider other than the implementer's " + implementerProvider + ": " + passedText(passed)
    }))
  })

export const chosenReviewerLine = (pick: ChainPick<ReviewerEntry>): string =>
  "orc: the review turn runs on " + pick.entry.model + ", entry " + pick.position.toString() + " of the reviewer chain"
  + (pick.passed.length === 0 ? "" : ", after passing over " + passedText(pick.passed))
