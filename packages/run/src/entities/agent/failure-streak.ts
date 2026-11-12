import { Schema } from "effect"

export const askAfterFailures = 3

export const pauseAfterFailures = 2 * askAfterFailures

export interface FailureStreak {
  readonly command: string
  readonly failures: number
}

export const nextStreak = (streak: FailureStreak | null, command: string, failed: boolean): FailureStreak | null =>
  !failed ? null : { command, failures: streak !== null && streak.command === command ? streak.failures + 1 : 1 }

export const failingFileName = "failing.json"

export const loopQuestionId = "looping"

export const FailingMark = Schema.Struct({ label: Schema.String, since: Schema.String })

export type FailingMark = typeof FailingMark.Type

export const failingText = (mark: FailingMark): string =>
  "Pi failed " + mark.label + " " + askAfterFailures.toString() + " times in a row"
