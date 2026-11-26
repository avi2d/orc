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

type Decider = DecidedAttention["answer"]["decider"]

const groups = [
  { decider: "owner", key: "owner", heading: "Decided by the owner" },
  { decider: "agent", key: "agent", heading: "Decided by the agent" },
  { decider: null, key: "unrecorded", heading: "Decider not recorded" }
] as const satisfies ReadonlyArray<{ readonly decider: Decider; readonly key: string; readonly heading: string }>

const basisOf = (item: DecidedAttention, decider: Decider): ReadonlyArray<string> => {
  if (item.decision !== null && item.decision.decider === decider) return [item.decision.basis]
  return decider === "agent" ? ["Not recorded"] : []
}

const decidedView = (t: Palette, item: DecidedAttention, answer: DecidedAttention["answer"], replaced: boolean): Element =>
  v_flex().id(`${replaced ? "replaced" : "decided"}-${item.id}`).gap(4).p(10).rounded(6).bg(t.raised).min_w_0()
    .child(div().font_semibold().child(`${item.task}${answer.inferred ? " · inferred" : ""}`))
    .child(div().whitespace_normal().child(item.text))
    .child(section(t, replaced ? "Replaced answer" : "Answer", div().whitespace_normal().child(answer.words)))
    .children(basisOf(item, answer.decider).map((basis) => section(t, "Basis", div().whitespace_normal().child(basis))))

const decidedGroups = (t: Palette, items: AgentAttention["decided"]): ReadonlyArray<Element> =>
  groups.flatMap(({ decider, key, heading }) => {
    const cards = items.flatMap((item) => [
      ...(item.overturned?.decider === decider ? [decidedView(t, item, item.overturned, true)] : []),
      ...(item.answer.decider === decider ? [decidedView(t, item, item.answer, false)] : [])
    ])
    return cards.length === 0 ? [] : [v_flex().id(`decided-by-${key}`).gap(6)
      .child(div().text_size(12).font_semibold().text_color(t.muted).child(heading))
      .children(cards)]
  })

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
        ...decidedGroups(t, agent.decided)
      ] : [])]
  }
}
