import { Schema } from "effect"

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

export const OrcReviewFindings = Schema.Array(OrcReviewFinding)
export const decodeOrcReviewFindings = Schema.decodeUnknownResult(Schema.fromJsonString(OrcReviewFindings))
export type OrcReviewFinding = typeof OrcReviewFinding.Type

export const ReviewFindings = Schema.Array(ReviewFinding)

export type ReviewFinding = typeof ReviewFinding.Type

export const RecordedReview = Schema.Struct({ status: Schema.Literal("passed"), findings: ReviewFindings, file: Schema.String })

export type ReviewOutcome = typeof RecordedReview.Type | { readonly status: "failed"; readonly reason: string }

export type ReviewAtHeadOutcome = ReviewOutcome & { readonly reusedFrom: string | null }
