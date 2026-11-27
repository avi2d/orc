import { expect, test } from "bun:test"
import type { AsyncContext, Context } from "gpui-kit"
import type { Card } from "../../../packages/herdr-app/src/agents"
import { agentsOpenKey } from "../../../packages/herdr-app/src/views"
import { cx, sharedValues } from "./gpui-fakes"

const idle = () => ({ cancel: () => undefined, is_done: () => true })

const done = (id: string): Card => ({
  key: id, id, title: id, project: "garden", known: true, kind: "ship", delivery: null,
  standing: { status: "Done" }, where: "PR ready", runId: id, checkout: null,
  sendBack: id, openPr: "https://github.com/example/garden/pull/8"
})

test("an Open run ask is taken on a timer tick, not inside render where the App refuses a notify", async () => {
  const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
  const ticks: Array<(tick: Context) => void> = []
  let notifies = 0
  const counting = Object.assign(class extends cx {}, {
    notify: () => { notifies += 1 },
    spawn: idle,
    timer: { ...cx.timer, every: (_ms: number, tick: (tick: Context) => void) => { ticks.push(tick); return idle() } }
  }) satisfies AsyncContext
  const agents = new OrcAgents()
  agents.refresh = () => undefined
  agents.init(null, counting)
  agents.list = { kind: "ok", cards: [done("garden-1"), done("garden-2")], reread: null }
  sharedValues.set(agentsOpenKey, { run: "garden-2", at: 1 })
  agents.render()
  expect(agents.selectedCard()?.key).toBe("garden-1")
  expect(notifies).toBe(0)
  for (const tick of ticks) tick(counting)
  expect(agents.selectedCard()?.key).toBe("garden-2")
  expect(notifies).toBeGreaterThan(0)
  expect(sharedValues.get(agentsOpenKey)).toBeNull()
})
