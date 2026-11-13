import { expect, mock, test } from "bun:test"

interface ElementRecord {
  readonly calls: Array<{ readonly method: string; readonly value: unknown }>
}

const elements: Array<ElementRecord> = []
const element = (): unknown => {
  const record: ElementRecord = { calls: [] }
  elements.push(record)
  const proxy = new Proxy(record, {
    get(target, name) {
      if (name === "calls") return target.calls
      return (...args: Array<unknown>) => {
        target.calls.push({ method: String(name), value: args[0] })
        return proxy
      }
    }
  })
  return proxy
}

mock.module("gpui-kit", () => ({ View: class {}, div: element }))
mock.module("gpui-base", () => ({ h_flex: element, v_flex: element }))
mock.module("herdr", () => ({ exec: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }), layout: () => null, theme: () => ({}) }))

test("a card uses pixel line height so the clipped title remains visible", async () => {
  const { default: Board } = await import("../../../packages/herdr-app/mods/orc-board/main")
  const board = new Board()
  const colors = {
    background: "#000000", surface: "#000000", chrome: "#000000", raised: "#000000",
    hover: "#000000", selected: "#000000", border: "#000000", foreground: "#ffffff",
    muted: "#ffffff", dim: "#ffffff", accent: "#ffffff", working: "#ffffff",
    blocked: "#ffffff", done: "#ffffff", ansi1: "#ffffff"
  } as const
  const title = "A title long enough to wrap across more than two lines in a card"
  board.card(colors, { id: "task-1", title, project: "orc", kind: "task", created: "2026-01-01", status: "new", held: false, parked: false, prState: null })
  const text = elements.find((entry) => entry.calls.some((call) => call.method === "child" && call.value === title))
  expect(text?.calls).toContainEqual({ method: "h", value: 36 })
  expect(text?.calls).toContainEqual({ method: "line_height", value: "18px" })
  expect(text?.calls.some((call) => call.method === "overflow_hidden")).toBe(true)
})
