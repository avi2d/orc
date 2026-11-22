import { useEffect, useState } from "react"
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app"
import type { BoardReading, rpcContract } from "./server"

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
      {reading.tasks.map((task) => (
        <li key={task.id} className="flex gap-3">
          <span className="shrink-0 font-mono text-muted-foreground">{task.id}</span>
          <span className="truncate">{task.title}</span>
        </li>
      ))}
    </ul>
  )
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "board", title: "orc Board", icon: "Columns", path: "board", component: Board })
})
