import { reportKinds, runKinds, type RunKind } from "../../shared/lib/index"

export { reportKinds, runKinds, type RunKind }
export type ReportKind = typeof reportKinds[number]
export const taskKinds = [...runKinds, "decision"] as const
export type TaskKind = typeof taskKinds[number]

export const isTaskKind = (word: string): word is TaskKind => taskKinds.some((kind) => kind === word)

export const isRunKind = (word: string): word is RunKind => runKinds.some((kind) => kind === word)

export const unknownKind = (word: string): string => "the kind " + word + " is not ship, scout, task, parent or decision"

export const unknownRunKind = (word: string): string =>
  word === "decision"
    ? "orc run takes no --kind decision: a decision is the captain's to answer through orc backlog answer, so it never runs"
    : "the kind " + word + " is not ship, scout, task or parent"

export const agentReportFileName = "agent-report.md"

export const runDirFor = (home: string, runId: string): string => home + "/runs/" + runId
