import { Schema } from "effect"
import { ReviewerWait } from "../../entities/run-history/index"
import { RecordedReview } from "./review-outcome"

const ReviewWaitCheckpoint = Schema.Struct({
  ...ReviewerWait.fields,
  head: Schema.NonEmptyString,
  sentPerRound: Schema.Array(RecordedReview.fields.findings)
})
export type ReviewWaitCheckpoint = typeof ReviewWaitCheckpoint.Type
export { ReviewWaitCheckpoint }
