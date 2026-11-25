import { type Context, type Element, div } from "gpui-kit"
import { v_flex } from "gpui-base"
import { actionButton, section } from "./ask-view"
import type { AttentionItem, DecidedAttention } from "./guard-attention"
import type { AgentAttention } from "./inbox-read"
import type { palette } from "./palette"

type Palette = ReturnType<typeof palette>

const pendingView = (t: Palette, item: AttentionItem): Element =>
  v_flex().id(`pending-${item.id}`).gap(4).p(10).rounded(6).bg(t.raised).min_w_0()
    .child(div().font_semibold().child(`${item.task} · With the agent`))
    .child(div().whitespace_normal().child(item.subject ?? item.text))
    .child(section(t, "Basis", div().whitespace_normal().child(item.decision?.basis ?? "The attention record assigns this item to the agent.")))

const decidedView = (t: Palette, item: DecidedAttention): Element =>
  v_flex().id(`decided-${item.id}`).gap(4).p(10).rounded(6).bg(t.raised).min_w_0()
    .child(div().font_semibold().child(`${item.task} · Decided by the agent`))
    .child(div().whitespace_normal().child(item.text))
    .child(section(t, "Answer", div().whitespace_normal().child(item.overturned ?? item.answer)))
    .child(section(t, "Basis", div().whitespace_normal().child(item.decision.basis)))

const overrideView = (t: Palette, item: DecidedAttention): Element =>
  v_flex().id(`override-${item.id}`).gap(4).p(10).rounded(6).bg(t.raised).min_w_0()
    .child(div().font_semibold().child(`${item.task} · Decided by you`))
    .child(div().whitespace_normal().child(item.text))
    .child(section(t, "Answer replacing the agent’s", div().whitespace_normal().child(item.answer)))

export class AgentAttentionSection {
  expanded = false

  render(t: Palette, agent: AgentAttention): ReadonlyArray<Element> {
    const count = agent.pending.length + agent.decided.length
    if (count === 0) return []
    const label = `${this.expanded ? "▾" : "▸"} Agent attention (${count})`
    return [v_flex().id("agent-attention").gap(6).items_stretch().flex_shrink_0()
      .child(actionButton(t, "toggle-agent-attention", label, false, (cx: Context) => { this.expanded = !this.expanded; cx.notify() }))
      .children(this.expanded ? [
        ...agent.pending.map((item) => pendingView(t, item)),
        ...agent.decided.flatMap((item) => item.overturned === null ? [decidedView(t, item)] : [decidedView(t, item), overrideView(t, item)])
      ] : [])]
  }
}
