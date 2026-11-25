import { Result, Schema } from "effect"

const ReviewFinding = Schema.Struct({
  id: Schema.String,
  file: Schema.String,
  line: Schema.NullOr(Schema.Int),
  severity: Schema.Literals(["blocker", "major", "minor"]),
  action: Schema.String,
  description: Schema.String
})

const OrcReviewFinding = Schema.Struct({
  ...ReviewFinding.fields,
  severity: Schema.Literals(["error", "warning", "info"])
})

const OrcReviewFindings = Schema.Array(OrcReviewFinding)
const decodeOrcFindings = Schema.decodeUnknownResult(Schema.fromJsonString(OrcReviewFindings))

export class OrcReviewOutputError extends Schema.TaggedError<OrcReviewOutputError>()("OrcReviewOutputError", {
  message: Schema.String
}) {}

export const decodeOrcReviewFindings = (input: string) =>
  decodeOrcFindings(input).pipe(Result.mapError((error) => new OrcReviewOutputError({ message: error.message })))

export const ReviewFindings = Schema.Array(ReviewFinding)

export type ReviewFinding = typeof ReviewFinding.Type

export const RecordedReview = Schema.Struct({ status: Schema.Literal("passed"), findings: ReviewFindings, file: Schema.String })

export type ReviewOutcome = typeof RecordedReview.Type | { readonly status: "failed"; readonly reason: string }

export type ReviewAtHeadOutcome = ReviewOutcome & { readonly reusedFrom: string | null }
