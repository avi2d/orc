export const mergeStages = ["updating", "checks-running", "conflicted", "check-failed", "merged"] as const
export type MergeStage = typeof mergeStages[number]

export const approvalStage = (stage: MergeStage): string => {
  switch (stage) {
    case "updating": return "Updating from main"
    case "checks-running": return "Checks running"
    case "conflicted": return "Merge conflict"
    case "check-failed": return "Check failed"
    case "merged": return "Merged"
  }
}
