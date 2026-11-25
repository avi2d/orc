export const mergeStages = ["updating", "checks-running", "conflicted", "check-failed", "merged"] as const
type MergeStage = typeof mergeStages[number]

export interface RecordedMerge {
  readonly stage: MergeStage
  readonly detail: string | null
}

export type MergeOutcome = { readonly kind: "merging" } | { readonly kind: "failed"; readonly reason: string }

interface ApprovalShown {
  readonly button: string
  readonly notice: string | null
}

export const approvalStage = (stage: MergeStage): string => {
  switch (stage) {
    case "updating": return "Updating from main"
    case "checks-running": return "Checks running"
    case "conflicted": return "Merge conflict"
    case "check-failed": return "Check failed"
    case "merged": return "Merged"
  }
}

const inProgress = (recorded: RecordedMerge | undefined): string =>
  recorded?.stage === "updating" || recorded?.stage === "checks-running" || recorded?.stage === "merged" ? approvalStage(recorded.stage) : "Merging"

const failureNotice = (recorded: RecordedMerge | undefined): string | null => {
  if (recorded?.stage === "conflicted") return recorded.detail === null ? "Merge conflict" : `Merge conflict with ${recorded.detail}`
  if (recorded?.stage === "check-failed") return recorded.detail === null ? "Check failed" : `Check failed: ${recorded.detail}`
  return null
}

export const approvalShown = (attempt: MergeOutcome | null, recorded: RecordedMerge | undefined): ApprovalShown => {
  if (attempt?.kind === "merging") return { button: inProgress(recorded), notice: null }
  if (attempt?.kind === "failed") return { button: "Approve and merge", notice: failureNotice(recorded) ?? attempt.reason }
  return { button: "Approve and merge", notice: null }
}

export const sentBackLabel = (pr: string, recorded: RecordedMerge | undefined): string =>
  recorded?.stage === "conflicted" || recorded?.stage === "check-failed" ? `Sent back ${pr}: ${approvalStage(recorded.stage)}` : `Sent back ${pr}`
