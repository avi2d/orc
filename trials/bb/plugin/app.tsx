import { useEffect, useState } from "react"
import { UrlLink, definePluginApp, useRpc } from "@get-bb/plugin-sdk/app"
import type { BoardLine, BoardReading, rpcContract } from "./server"

const actorLabels = { owner: "owner acts", orc: "orc acts", ci: "CI acts" } as const

function TaskLine({ task }: { readonly task: BoardLine }) {
  return (
    <li className="flex items-baseline gap-3">
      <span className="shrink-0 font-mono text-muted-foreground">{task.id}</span>
      <span className="min-w-0 truncate">{task.title}</span>
      <span className="shrink-0 text-muted-foreground">{task.waits}</span>
      {task.actor === null ? null : <span className="shrink-0 font-medium">{actorLabels[task.actor]}</span>}
      {task.pr === null ? null : <UrlLink href={task.pr} className="shrink-0 underline">{"PR #" + task.pr.slice(task.pr.lastIndexOf("/") + 1)}</UrlLink>}
    </li>
  )
}

function Board() {
  const rpc = useRpc<typeof rpcContract>()
  const [reading, setReading] = useState<BoardReading | null>(null)
  useEffect(() => {
    void rpc.call("board").then(setReading, (error: unknown) => setReading({ kind: "failed", reason: String(error) }))
  }, [rpc])
  if (reading === null) return <p className="p-4 text-sm text-muted-foreground">Reading the backlog</p>
  if (reading.kind === "failed") return <p className="p-4 text-sm text-destructive">{reading.reason}</p>
  return (
    <ul className="flex flex-col gap-1 overflow-auto p-4 text-sm">
      {reading.tasks.map((task) => <TaskLine key={task.id} task={task} />)}
    </ul>
  )
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "board", title: "orc Board", icon: "Columns", path: "board", component: Board })
})
