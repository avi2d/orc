import { type Guard, ok } from "./guard"
import { attention } from "./guard-attention"
import { type BoardBacklog, boardBacklog } from "./guard-board"
import { inboxItems } from "./inbox"
import { type Reading, readJson } from "./orc-read"
import type { TaskDetail } from "./task"
import { taskDetails } from "./task-guard"

export interface BoardDocuments {
  readonly backlog: BoardBacklog
  readonly awaiting: ReadonlySet<string>
}

const boardWithDetails: Guard<{ readonly board: BoardBacklog; readonly details: ReadonlyArray<TaskDetail> }> = (value, at) => {
  const board = boardBacklog(value, at)
  if (board.kind !== "ok") return board
  const details = taskDetails(value, at)
  return details.kind !== "ok" ? details : ok({ board: board.value, details: details.value })
}

export const readBoard = (): Promise<Reading<BoardDocuments>> =>
  Promise.all([
    readJson("orc", ["backlog", "--json"], boardWithDetails),
    readJson("orc", ["attention", "--json"], attention)
  ]).then(([listed, asked]) => {
    if (listed.kind !== "ok") return listed
    if (asked.kind !== "ok") return asked
    const awaiting = new Set(inboxItems(listed.value.details, asked.value.items).map((item) => item.task))
    return { kind: "ok", value: { backlog: listed.value.board, awaiting } }
  })
