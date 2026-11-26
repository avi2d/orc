import { Effect } from "effect"
import type { BacklogError } from "../../entities/backlog/index"
import { refuse } from "./branch-update"

const defaultFirstPollSeconds = 1
const longestPollSeconds = 15

export const firstPollFromEnv = (value: string | undefined): Effect.Effect<number, BacklogError> => {
  const text = (value ?? "").trim()
  if (text === "") {
    return Effect.succeed(defaultFirstPollSeconds)
  }
  const seconds = Number(text)
  return /^\d+(\.\d+)?$/.test(text) && seconds > 0 && seconds <= longestPollSeconds
    ? Effect.succeed(seconds)
    : refuse("ORC_MERGE_POLL_SECONDS is " + text + ", which is not a number of seconds above zero and at most " + longestPollSeconds)
}

export const pollWaitSeconds = (firstPollSeconds: number, poll: number): number =>
  Math.min(firstPollSeconds * 2 ** poll, longestPollSeconds)
