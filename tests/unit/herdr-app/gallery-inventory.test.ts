import { expect, test } from "bun:test"
import { galleryStories } from "../../../packages/herdr-app/src/gallery-stories"
import { alertColors, dotColour, tw, zinc } from "../../../packages/herdr-app/src/kit-colors"
import { resolvePalette } from "../../../packages/herdr-app/src/palette-values"

const graphite = {
  background: "#17191d", surface: "#17191d", chrome: "#101114", raised: "#2c2e31",
  hover: "#ffffff0e", selected: "#ffffff17", border: "#ffffff18",
  foreground: "#eeeeef", muted: "#98999b", dim: "#696a6d", accent: "#96b2d7",
  working: "#e5c07b", blocked: "#f0705f", done: "#76a8ff", ansi1: "#dc8c95", ansi2: "#a6bd91",
  solid: "#eeeeef", solid_foreground: "#111215"
} as const

const paper = {
  background: "#ffffff", surface: "#ffffff", chrome: "#f1f1ee", raised: "#f6f6f6",
  hover: "#0000000c", selected: "#00000012", border: "#00000017",
  foreground: "#1b1b1e", muted: "#69696b", dim: "#969698", accent: "#1f62d0",
  working: "#9a6700", blocked: "#c93c2c", done: "#2f6fe4", ansi1: "#c62a2a", ansi2: "#1a7f37",
  solid: "#1b1b1e", solid_foreground: "#ffffff"
} as const

test("resolving Graphite and Paper retains every panel role without leaking terminal-only colours", () => {
  expect(resolvePalette({ ...graphite, ansi0: "#334455" })).toEqual(graphite)
  expect(resolvePalette({ ...paper, ansi0: "#123456" })).toEqual(paper)
})

test("an omitted or non-hash host role falls back instead of borrowing another role's colour", () => {
  const palette = resolvePalette({ foreground: "rgb(10, 20, 30)", accent: "#custom" })
  expect(palette.surface).toBe("#808080")
  expect(palette.foreground).toBe("#808080")
  expect(palette.accent).toBe("#custom")
})

test("the swatch inventory retains the shipped zinc values, status colours, and translucent alert fills", () => {
  expect(zinc).toEqual({
    s1: "#1f1f22", s2: "#27272a", s3: "#3f3f46", border: "#27272a", borderAccent: "#303036",
    accent: "#e4e4e7", accentFg: "#18181b", muted: "#a1a1aa", clear: "#00000000"
  })
  expect(dotColour).toEqual({
    "Awaiting you": "#db932e", Running: "#5caaf6", Queued: "#71717a", Failed: "#f7796d", Done: "#35c264"
  })
  expect(tw).toEqual({
    red400: "#ff6467", amber500: "#fe9a00", emerald400: "#00d492", emerald500: "#00bc7d",
    blue400: "#51a2ff", blue500: "#2b7fff", error: "#fb414a"
  })
  expect(alertColors).toEqual({
    neutral: { bg: "#ffffff0f", colour: "#a1a1aa" },
    info: { bg: "#2b7fff29", colour: "#51a2ff" },
    warning: { bg: "#fe9a0029", colour: "#fe9a00" },
    error: { bg: "#fb414a29", colour: "#fb414a" },
    success: { bg: "#00bc7d29", colour: "#00d492" }
  })
})

test("the gallery catalog does not omit a component or reuse an example address", () => {
  const ids = galleryStories.map((story) => story.id)
  expect(new Set(ids).size).toBe(ids.length)
  expect(new Set(galleryStories.map((story) => story.component))).toEqual(new Set([
    "alert", "button", "card", "checkIcon", "field", "fieldWithButton", "kbd", "linkedText",
    "radio", "selectTrigger", "statusDot", "tab", "threadDecided", "threadEntry", "uniformRows", "vendorLogo"
  ]))
})

test("each button size and look has both an enabled and disabled example at different addresses", () => {
  for (const size of [24, 32]) {
    for (const look of ["primary", "secondary", "ghost"]) {
      for (const disabled of [false, true]) {
        const id = `button.${size}.${look}.${disabled ? "disabled" : "enabled"}`
        expect(galleryStories.find((story) => story.id === id)).toMatchObject({ component: "button", size, look, disabled })
      }
    }
  }
})
