import { type AsyncContext, type Context, type Element, View, div } from "gpui-kit"
import { h_flex, v_flex } from "gpui-base"
import { openOverlay } from "herdr"
import { actionButton, listenFor, optionView, sendOrc } from "../../src/ask-view"
import type { InboxApproval, InboxItem } from "../../src/inbox"
import { type InboxDocuments, readInbox } from "../../src/inbox-read"
import { InboxAnswers, inboxItemView } from "../../src/inbox-view"
import type { Reading } from "../../src/orc-read"
import { palette } from "../../src/palette"
import { refreshWhenShown, reloadNow } from "../../src/views"

type Palette = ReturnType<typeof palette>

export default class OrcInbox extends View {
  reading: Reading<InboxDocuments> = { kind: "reading" }
  visible = false
  lastRead = 0
  busy = false
  stale = false
  answers = new InboxAnswers((cx) => reloadNow(cx, this))
  merging: InboxApproval | null = null

  load = readInbox

  override init(_props: unknown, cx: AsyncContext): void {
    refreshWhenShown("orc-inbox", 10_000, cx, this)
    cx.timer.every(150, (tick) => {
      if (this.reading.kind !== "ok") return
      const { items, unread } = this.reading.value
      this.answers.sync(tick, items.filter((item) => item.kind !== "pr"), unread)
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
    if (item !== null) sendOrc(this.answers, cx, item.key, item.action.argv, () => undefined)
  }

  render(): Element {
    const t = palette()
    const root = v_flex().id("root").size_full().min_w_0().bg(t.background).text_size(13).text_color(t.foreground)
    if (this.reading.kind === "failed") return root.child(div().p(16).text_color(t.blocked).child(this.reading.reason))
    if (this.reading.kind === "reading") return root.child(div().p(16).text_color(t.muted).child("Reading the inbox"))
    const { items, unread } = this.reading.value
    const body = v_flex().id("items").flex_1().min_h_0().overflow_y_scrollbar().p(16).gap(12)
      .children([...unread.values()].map((reason) => div().text_color(t.blocked).child(reason)))
    if (items.length === 0) return root.child(unread.size === 0 ? body.child(div().text_color(t.muted).child("No task awaits you")) : body)
    return root.child(body.children(items.map((item) => this.item(t, item))))
  }

  item(t: Palette, item: InboxItem): Element {
    if (item.kind !== "pr") return this.answers.item(t, item)
    const sent = this.answers.sent.get(item.key)
    const sending = sent?.kind === "sending"
    const approve = actionButton(t, `approve-${item.key}`, sending ? "Merging" : "Approve", sending, () => this.askMerge(item))
    return inboxItemView(t, item, (option) => optionView(t, `option-${item.key}-${option.letter}`, option), [h_flex().child(approve)], sent)
  }
}
