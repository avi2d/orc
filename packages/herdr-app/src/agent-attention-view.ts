import { type Context, type Element, div } from "gpui-kit"
import { h_flex, v_flex } from "gpui-base"
import { section } from "./ask-view"
import { button, card } from "./kit"
import type { AttentionItem, DecidedAttention } from "./guard-attention"
import type { AgentAttention } from "./inbox-read"
import { linkedCardText } from "./links-view"
import type { palette } from "./palette"

type Palette = ReturnType<typeof palette>

const pendingView = (t: Palette, item: AttentionItem): Element =>
  card().id(`pending-${item.id}`).gap(4).p(12).min_w_0()
    .child(div().font_semibold().child(`${item.task} · With the agent`))
    .child(linkedCardText(`pending-text-${item.id}`, item.subject ?? item.text).whitespace_normal())
    .child(section(t, "Basis", linkedCardText(`pending-basis-${item.id}`, item.decision?.basis ?? "The attention record assigns this item to the agent.").whitespace_normal()))

type Decider = DecidedAttention["answer"]["decider"]
type Decision = NonNullable<DecidedAttention["decision"]>

const decisionWords: Readonly<Record<Decision["kind"], string>> = {
  answered: "Answered", escalated: "Escalated to the owner", "asked-back": "Asked the worker back", duplicate: "Same question as another"
}

const groups = [
  { decider: "owner", key: "owner", heading: "Decided by the owner" },
  { decider: "agent", key: "agent", heading: "Decided by the agent" },
  { decider: null, key: "unrecorded", heading: "Decider not recorded" }
] as const satisfies ReadonlyArray<{ readonly decider: Decider; readonly key: string; readonly heading: string }>

const basisOf = (item: DecidedAttention, decider: Decider): ReadonlyArray<string> => {
  if (item.decision !== null && item.decision.decider === decider) return [item.decision.basis]
  return decider === "agent" ? ["Not recorded"] : []
}

const decidedView = (t: Palette, item: DecidedAttention, answer: DecidedAttention["answer"], replaced: boolean): Element => {
  const id = `${replaced ? "replaced" : "decided"}-${item.id}`
  return card().id(id).gap(4).p(12).min_w_0()
    .child(div().font_semibold().child(`${item.task}${answer.inferred ? " · inferred" : ""}`))
    .child(linkedCardText(`${id}-text`, item.text).whitespace_normal())
    .child(section(t, replaced ? "Replaced answer" : "Answer", linkedCardText(`${id}-answer`, answer.words).whitespace_normal()))
    .children(basisOf(item, answer.decider).map((basis) => section(t, "Basis", linkedCardText(`${id}-basis`, basis).whitespace_normal())))
}

const unansweredView = (t: Palette, item: DecidedAttention, decision: Decision): Element =>
  card().id(`agent-decision-${item.id}`).gap(4).p(12).min_w_0()
    .child(div().font_semibold().child(item.task))
    .child(linkedCardText(`agent-decision-text-${item.id}`, item.text).whitespace_normal())
    .child(section(t, "Decision", div().whitespace_normal().child(decisionWords[decision.kind])))
    .child(section(t, "Basis", linkedCardText(`agent-decision-basis-${item.id}`, decision.basis).whitespace_normal()))

const agentDecisionWithoutAnswer = (item: DecidedAttention): Decision | null =>
  item.decision?.decider === "agent" && item.answer.decider !== "agent" && item.overturned?.decider !== "agent" ? item.decision : null

const unansweredCards = (t: Palette, item: DecidedAttention, decider: Decider): ReadonlyArray<Element> => {
  const decision = decider === "agent" ? agentDecisionWithoutAnswer(item) : null
  return decision === null ? [] : [unansweredView(t, item, decision)]
}

const decidedGroups = (t: Palette, items: AgentAttention["decided"]): ReadonlyArray<Element> =>
  groups.flatMap(({ decider, key, heading }) => {
    const cards = items.flatMap((item) => [
      ...(item.overturned?.decider === decider ? [decidedView(t, item, item.overturned, true)] : []),
      ...(item.answer.decider === decider ? [decidedView(t, item, item.answer, false)] : []),
      ...unansweredCards(t, item, decider)
    ])
    return cards.length === 0 ? [] : [v_flex().id(`decided-by-${key}`).gap(6)
      .child(div().text_size(12).font_semibold().text_color(t.muted).child(heading))
      .children(cards)]
  })

const attentionCount = (agent: AgentAttention): number => agent.pending.length + agent.decided.length

export class AgentAttentionSection {
  expanded = false

  shows(agent: AgentAttention): boolean {
    return attentionCount(agent) > 0
  }

  render(t: Palette, agent: AgentAttention): ReadonlyArray<Element> {
    if (!this.shows(agent)) return []
    const label = `${this.expanded ? "▾" : "▸"} Agent attention (${attentionCount(agent)})`
    return [v_flex().id("agent-attention").gap(6).items_stretch().flex_shrink_0()
      .child(h_flex().child(button(t, "toggle-agent-attention", label, "ghost", 24, (cx: Context) => { this.expanded = !this.expanded; cx.notify() })))
      .children(this.expanded ? [
        ...agent.pending.map((item) => pendingView(t, item)),
        ...decidedGroups(t, agent.decided)
      ] : [])]
  }
}
