import type { Color } from "gpui-kit"

const fallback = "#808080"

const defaults = {
  background: fallback, surface: fallback, chrome: fallback, raised: fallback, hover: fallback,
  selected: fallback, border: fallback, foreground: fallback, muted: fallback, dim: fallback,
  accent: fallback, working: fallback, blocked: fallback, done: fallback, ansi1: fallback,
  ansi2: fallback, solid: fallback, solid_foreground: fallback
} as const satisfies Readonly<Record<string, Color>>

export type Palette = Readonly<Record<keyof typeof defaults, Color>>

const isColor = (value: string | undefined): value is Color => value?.startsWith("#") === true

export const resolvePalette = (colors: Readonly<Record<string, string | undefined>>): Palette => ({
  ...defaults,
  ...Object.fromEntries(Object.keys(defaults).flatMap((name) => {
    const value = colors[name]
    return isColor(value) ? [[name, value] as const] : []
  }))
})
