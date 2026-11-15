import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const floatingEntries = (node: unknown): ReadonlyArray<unknown> => {
  if (!isRecord(node)) return []
  const floating = Array.isArray(node["floating"]) ? node["floating"] : []
  const children = Array.isArray(node["children"]) ? node["children"] : []
  return [...floating, ...children.flatMap(floatingEntries)]
}

const holdsContent = (entry: unknown): boolean => {
  if (!isRecord(entry) || !isRecord(entry["content"])) return false
  const content = entry["content"]
  const type = entry["type"]
  return (type === undefined || type === "block") && (typeof content["mod"] === "string" || typeof content["terminal"] === "string")
}

test("floats only blocks with content, never a column Herdr refuses with the whole layout", async () => {
  const layout: unknown = JSON.parse(await readFile(join(import.meta.dir, "../../../packages/herdr-app/layouts/orc.json"), "utf8"))
  const entries = floatingEntries(layout)
  expect(entries.length).toBeGreaterThan(0)
  expect(entries.filter((entry) => !holdsContent(entry))).toEqual([])
})
