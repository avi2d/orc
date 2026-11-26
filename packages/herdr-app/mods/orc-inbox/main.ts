import { type AsyncContext, type Context, type Element, View, div } from "gpui-kit"
import { v_flex } from "gpui-base"
import { openOverlay } from "herdr"
import { AgentAttentionSection } from "../../src/agent-attention-view"
import { runMerge } from "../../src/agents-merge"
import { listenFor } from "../../src/ask-view"
import type { InboxApproval, InboxItem } from "../../src/inbox"
import { type InboxDocuments, readInbox } from "../../src/inbox-read"
import { InboxAnswers } from "../../src/inbox-view"
import type { Reading } from "../../src/orc-read"
import { palette } from "../../src/palette"
import { rowsList } from "../../src/rows-list"
import { refreshWhenShown, reloadNow } from "../../src/views"

type InboxRow =
  | { readonly kind: "item"; readonly item: InboxItem }
  | { readonly kind: "none-awaits" }
  | { readonly kind: "agent-attention" }

const rowKey = (row: InboxRow): string => row.kind === "item" ? `item-${row.item.key}` : row.kind

export default class OrcInbox extends View {
  reading: Reading<InboxDocuments> = { kind: "reading" }
  visible = false
  lastRead = 0
  busy = false
  stale = false
  answers = new InboxAnswers((cx) => reloadNow(cx, this))
  agentAttention = new AgentAttentionSection()
  merging: InboxApproval | null = null

  load = readInbox

  override init(_props: unknown, cx: AsyncContext): void {
    refreshWhenShown("orc-inbox", 10_000, cx, this)
    cx.timer.every(150, (tick) => {
      if (this.reading.kind === "ok") this.answers.sync(tick, this.reading.value.items)
    })
    cx.spawn((task) => listenFor("merge", () => this.merge(task)))
  }

  askMerge(item: InboxApproval): void {
    this.merging = item
    openOverlay({
      mod: "confirm",
      kind: "dialog",
      width: 420,
      height: 180,
      props: { title: `Merge the PR of ${item.task}?`, detail: `orc ${item.action.argv.join(" ")}`, command: { name: "orc-inbox.merge" } }
    })
  }

  merge(cx: Context): void {
    const item = this.merging
    this.merging = null
    if (item === null || this.answers.busy(item.key)) return
    this.answers.sent.set(item.key, { kind: "sending" })
    cx.spawn((task) => runMerge(item.task).then((problem) => {
      if (problem === null) {
        this.answers.sent.delete(item.key)
        this.answers.recorded.add(item.key)
      } else {
        this.answers.sent.set(item.key, { kind: "failed", reason: problem })
      }
      reloadNow(task, this)
      task.notify()
    }))
    cx.notify()
  }

  render(): Element {
    const t = palette()
    const root = v_flex().id("root").size_full().min_w_0().bg(t.background).text_size(13).text_color(t.foreground)
    if (this.reading.kind === "failed") return root.child(div().p(16).text_color(t.blocked).child(this.reading.reason))
    if (this.reading.kind === "reading") return root.child(div().p(16).text_color(t.muted).child("Reading the inbox"))
    const { items, agent } = this.reading.value
    const rows: ReadonlyArray<InboxRow> = [
      ...(items.length === 0 ? [{ kind: "none-awaits" } as const] : items.map((item) => ({ kind: "item", item } as const))),
      ...(this.agentAttention.shows(agent) ? [{ kind: "agent-attention" } as const] : [])
    ]
    const row = (shown: InboxRow): Element => {
      switch (shown.kind) {
        case "none-awaits":
          return div().text_color(t.muted).child("No task awaits you")
        case "agent-attention":
          return v_flex().children(this.agentAttention.render(t, agent))
        case "item":
          return this.answers.item(t, shown.item, (approval) => this.askMerge(approval))
      }
    }
    return root.child(rowsList("items", rows, rowKey, row, { x: 16, y: 16, gap: 12 }))
  }
}
