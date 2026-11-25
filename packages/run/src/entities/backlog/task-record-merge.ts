import { Schema } from "effect"

export const MergeRecord = Schema.Struct({
  basis: Schema.Literals(["captain-word", "yolo-green"]),
  head: Schema.String,
  green: Schema.Array(Schema.String),
  stage: Schema.Literals(["updating", "checks-running", "conflicted", "check-failed", "merged"]),
  detail: Schema.optional(Schema.String)
})
export type MergeRecord = typeof MergeRecord.Type
