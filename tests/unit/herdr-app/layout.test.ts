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

const mods = (node: unknown): ReadonlyArray<string> => {
  if (!isRecord(node)) return []
  const content = isRecord(node["content"]) && typeof node["content"]["mod"] === "string" ? [node["content"]["mod"]] : []
  const header = isRecord(node["header"]) ? mods(node["header"]) : []
  const nested = ["children", "floating"].flatMap((key) => Array.isArray(node[key]) ? node[key].flatMap(mods) : [])
  return [...content, ...header, ...nested]
}

test("the design system layout holds only the gallery, and the orc layout never docks the gallery beside the board", async () => {
  const root = join(import.meta.dir, "../../../packages/herdr-app/layouts")
  const gallery: unknown = JSON.parse(await readFile(join(root, "orc-design-system.json"), "utf8"))
  const orc: unknown = JSON.parse(await readFile(join(root, "orc.json"), "utf8"))
  expect(mods(gallery)).toEqual(["orc-design-system"])
  expect(mods(orc)).not.toContain("orc-design-system")
})

const stackChildren = (node: unknown, stack: string): ReadonlyArray<string> => {
  if (!isRecord(node)) return []
  const children = Array.isArray(node["children"]) ? node["children"] : []
  if (node["id"] === stack) return children.flatMap((entry) => isRecord(entry) && typeof entry["id"] === "string" ? [entry["id"]] : [])
  return children.flatMap((entry) => stackChildren(entry, stack))
}

test("selects with each layout:orc key a child the orc-views stack holds, so cmd-4 opens the Inbox instead of nothing", async () => {
  const root = join(import.meta.dir, "../../../packages/herdr-app")
  const layout: unknown = JSON.parse(await readFile(join(root, "layouts/orc.json"), "utf8"))
  const keys: unknown = JSON.parse(await readFile(join(root, "keys.json"), "utf8"))
  const children = stackChildren(layout, "orc-views")
  expect(children).toContain("orc-inbox")
  const section = isRecord(keys) && isRecord(keys["layout:orc"]) ? keys["layout:orc"] : {}
  expect(section["cmd-4"]).toEqual({ command: "layout.select", args: { stack: "orc-views", child: "orc-inbox" } })
  const selected = Object.values(section).flatMap((binding) => isRecord(binding) && isRecord(binding["args"]) ? [binding["args"]["child"]] : [])
  expect(selected.filter((child) => typeof child !== "string" || !children.includes(child))).toEqual([])
})
