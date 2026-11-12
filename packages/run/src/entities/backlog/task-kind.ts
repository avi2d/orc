export const reportKinds = ["scout", "task", "parent"] as const
export type ReportKind = typeof reportKinds[number]
export const taskKinds = ["ship", ...reportKinds] as const
export type TaskKind = typeof taskKinds[number]

export const isTaskKind = (word: string): word is TaskKind => taskKinds.some((kind) => kind === word)

export const unknownKind = (word: string): string => "the kind " + word + " is not ship, scout, task or parent"

export const agentReportFileName = "agent-report.md"

export const runDirFor = (home: string, runId: string): string => home + "/runs/" + runId
