export const viewsStack = "orc-views"

export const views = [
  { id: "orc-board", label: "Board", key: "⌘1" },
  { id: "orc-resources", label: "Resources", key: "⌘2" },
  { id: "orc-agents", label: "Agents", key: "⌘3" }
] as const

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const activeChild = (node: unknown, stack: string): string | null => {
  if (!isRecord(node)) {
    return null
  }
  if (node["id"] === stack) {
    return typeof node["active"] === "string" ? node["active"] : null
  }
  const children = Array.isArray(node["children"]) ? node["children"] : []
  for (const child of children) {
    const found = activeChild(child, stack)
    if (found !== null) {
      return found
    }
  }
  return null
}
