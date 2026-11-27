import { type Array as Arr, Effect, Schema } from "effect"
import type { ProviderRoom, ReviewerEntry } from "../../shared/config/index"

export class NoReviewerRoom extends Schema.TaggedError<NoReviewerRoom>()("NoReviewerRoom", {
  message: Schema.String,
  implementerProviders: Schema.NonEmptyArray(Schema.String)
}) {}

interface PassedEntry {
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

export const pickChainEntry = <T extends ReviewerEntry>(
  chain: Arr.NonEmptyReadonlyArray<T>,
  implementerProviders: Arr.NonEmptyReadonlyArray<string>,
  roomOf: (entry: T) => ProviderRoom
): Effect.Effect<ChainPick<T>, NoReviewerRoom> => {
  const passed: Array<PassedEntry> = []
  for (const [index, entry] of chain.entries()) {
    if (implementerProviders.includes(entry.provider)) {
      passed.push({ entry, reason: entry.provider + " wrote commits for this change" })
      continue
    }
    const room = roomOf(entry)
    if (room.kind === "room") {
      return Effect.succeed({ entry, position: index + 1, passed })
    }
    passed.push({ entry, reason: room.reason })
  }
  return Effect.fail(new NoReviewerRoom({
    implementerProviders,
    message: "no reviewer in the chain has quota room on a provider that did not write the change; excluded providers: " + implementerProviders.join(", ") + ": " + passedText(passed)
  }))
}

export const chosenReviewerLine = (pick: ChainPick<ReviewerEntry>): string =>
  "orc: the review turn runs on " + pick.entry.model + ", entry " + pick.position.toString() + " of the reviewer chain"
  + (pick.passed.length === 0 ? "" : ", after passing over " + passedText(pick.passed))
