import type { Color } from "gpui-kit"
import type { CardStatus } from "./agents"

export const zinc = {
  s1: "#1f1f22", s2: "#27272a", s3: "#3f3f46", border: "#27272a", borderAccent: "#303036",
  accent: "#e4e4e7", accentFg: "#18181b", muted: "#a1a1aa", clear: "#00000000"
} as const satisfies Readonly<Record<string, Color>>

export const dotColour = {
  "Awaiting you": "#db932e", Running: "#5caaf6", Queued: "#71717a", Failed: "#f7796d", Done: "#35c264"
} as const satisfies Readonly<Record<CardStatus, Color>>

export const tw = { red400: "#ff6467", amber500: "#fe9a00", emerald400: "#00d492", emerald500: "#00bc7d", blue400: "#51a2ff", blue500: "#2b7fff", error: "#fb414a" } as const

export const alertColors = {
  neutral: { bg: "#ffffff0f", colour: zinc.muted },
  info: { bg: `${tw.blue500}29`, colour: tw.blue400 },
  warning: { bg: `${tw.amber500}29`, colour: tw.amber500 },
  error: { bg: `${tw.error}29`, colour: tw.error },
  success: { bg: `${tw.emerald500}29`, colour: tw.emerald400 }
} as const satisfies Readonly<Record<string, { readonly bg: Color; readonly colour: Color }>>
