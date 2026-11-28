import { type Card, type Standing, prNumber } from "./agents"
import type { Vendor } from "./kit"
import type { RunFacts, StepAgent } from "./run-agent"

export interface RowFacts {
  readonly title: string
  readonly model: string | null
  readonly vendor: Vendor | null
  readonly duration: string | null
  readonly waits: string | null
}

const efforts: Readonly<Record<string, string>> = { off: "", minimal: "mn", low: "l", medium: "m", high: "h", xhigh: "xh", max: "mx" }

const bareModel = (model: string): string => model.slice(model.lastIndexOf("/") + 1)

export const shortModel = (agent: StepAgent): string => {
  const name = bareModel(agent.model).replace(/^(claude|gpt)-/, "")
  const effort = agent.thinking === null ? "" : efforts[agent.thinking] ?? agent.thinking
  return effort === "" ? name : `${name} ${effort}`
}

export const vendorOf = (model: string): Vendor | null => {
  const provider = model.includes("/") ? model.slice(0, model.indexOf("/")) : ""
  const name = bareModel(model)
  if (name.startsWith("claude") || provider === "anthropic" || provider === "claude-bridge") return "claude"
  if (name.startsWith("gpt") || provider.startsWith("openai")) return "openai"
  return null
}

const titleWords = 3
const wordLetters = 16

export const shortTitle = (id: string, title: string): string => {
  const project = id.slice(0, Math.max(id.lastIndexOf("-"), 0))
  const bare = project !== "" && title.toLowerCase().startsWith(`${project.toLowerCase()}:`) ? title.slice(project.length + 1) : title
  const words = (bare.toLowerCase().match(/[a-z0-9]+/g) ?? []).slice(0, titleWords).map((word) => word.slice(0, wordLetters))
  return words.length === 0 ? id : `${id}-${words.join("-")}`
}

const minuteMs = 60_000

export const durationLabel = (ms: number): string => {
  const minutes = Math.floor(ms / minuteMs)
  if (minutes < 1) return "<1m"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

const since = (from: string | null, to: number): string | null => {
  const start = from === null ? Number.NaN : Date.parse(from)
  return Number.isNaN(start) ? null : durationLabel(Math.max(to - start, 0))
}

const between = (from: string | null, to: string | null): string | null => {
  const end = to === null ? Number.NaN : Date.parse(to)
  return Number.isNaN(end) ? null : since(from, end)
}

type Timed = Pick<Card, "standing">

const rowAgent = (card: Timed, facts: RunFacts | null): StepAgent | null => {
  if (facts === null) return null
  switch (card.standing.status) {
    case "Awaiting you":
      return card.standing.waiting.on === "answer" ? facts.running : facts.implement
    case "Running":
      return facts.running
    case "Queued":
      return null
    case "Failed":
    case "Done":
      return facts.implement
  }
}

const rowDuration = (card: Timed, facts: RunFacts | null, now: number): string | null => {
  switch (card.standing.status) {
    case "Awaiting you": {
      const waiting = card.standing.waiting
      return since(waiting.on === "answer" ? waiting.items[0]?.asked ?? null : waiting.item.asked, now)
    }
    case "Running":
      return since(facts?.started ?? null, now)
    case "Queued":
      return null
    case "Failed":
    case "Done":
      return between(facts?.started ?? null, facts?.ended ?? null)
  }
}

const waitsOn = (standing: Standing): string | null => {
  if (standing.status !== "Awaiting you") return null
  const waiting = standing.waiting
  if (waiting.on === "approval") return prNumber(waiting.item.link)
  const only = waiting.items.length === 1 ? waiting.items.at(0) : undefined
  return only === undefined ? `${waiting.items.length} items` : only.kind
}

export const rowFacts = (card: Pick<Card, "id" | "title" | "standing">, facts: RunFacts | null, now: number): RowFacts => {
  const agent = rowAgent(card, facts)
  return {
    title: shortTitle(card.id, card.title),
    model: agent === null ? null : shortModel(agent),
    vendor: agent === null ? null : vendorOf(agent.model),
    duration: rowDuration(card, facts, now),
    waits: waitsOn(card.standing)
  }
}
