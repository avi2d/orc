import { Effect, Schema } from "effect"
import { askBackWords, type Decider } from "../../shared/lib/index"
import { type AttentionItem, type ItemAnswer, StoredAttentionItem } from "./attention-item"

const decodeStoredItem = Schema.decodeEffect(Schema.fromJsonString(StoredAttentionItem))

type StoredItem = typeof StoredAttentionItem.Type
type ClosedItem = StoredItem & { readonly state: Extract<StoredItem["state"], { readonly kind: "closed" }> }

const oldAnswerDecider = ({ decision, state }: ClosedItem): Decider => {
  if (state.overturned !== undefined) {
    return "owner"
  }
  if (decision?.kind === "asked-back" && state.answer.words === askBackWords(decision.question)) {
    return "agent"
  }
  return (decision?.kind === "answered" || decision?.kind === "duplicate") && decision.at === state.answer.at
    ? "agent"
    : "owner"
}

const migrateAnswer = (item: ClosedItem): ItemAnswer => {
  const { kind, state: { answer } } = item
  if (answer.decider !== undefined) {
    return { ...answer, decider: answer.decider }
  }
  if (kind === "pr-ready" && (answer.words === "merged" || answer.words === "closed without merging")) {
    return { ...answer, decider: "agent", inferred: true }
  }
  return { ...answer, decider: oldAnswerDecider(item) }
}

const migrateItem = (item: StoredItem): AttentionItem => {
  const { decision, state, ...asked } = item
  return {
    ...asked,
    ...(decision === undefined ? {} : { decision: { ...decision, decider: decision.decider ?? "agent" } }),
    state: state.kind !== "closed" ? state : {
      kind: "closed",
      answer: migrateAnswer({ ...item, state }),
      ...(state.overturned === undefined ? {} : { overturned: { ...state.overturned, decider: state.overturned.decider ?? "agent" } })
    }
  }
}

export const decodeStoredAttention = (text: string) => decodeStoredItem(text).pipe(Effect.map(migrateItem))
