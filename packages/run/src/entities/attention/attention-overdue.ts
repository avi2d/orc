import type { AttentionItem } from "./attention-item"

const overdueMillis = 5 * 60 * 1000

export const ageMillis = (item: AttentionItem, nowMillis: number): number => Math.max(0, nowMillis - Date.parse(item.asked))

export const isOverdue = (item: AttentionItem, nowMillis: number): boolean => item.state.kind === "open" && ageMillis(item, nowMillis) > overdueMillis
