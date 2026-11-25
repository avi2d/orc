import { Schema } from "effect"

export const taskIdPattern = /^([A-Za-z0-9][A-Za-z0-9._-]*)-(\d+)$/
export const TaskId = Schema.String.check(Schema.isPattern(taskIdPattern))

export const reportKinds = ["scout", "task", "parent"] as const
export const runKinds = ["ship", ...reportKinds] as const
export type RunKind = typeof runKinds[number]
