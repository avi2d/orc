import { type Color, type Context, type Element, div, image, svg } from "gpui-kit"
import { Input, type InputState, h_flex, v_flex } from "gpui-base"
import type { CardStatus } from "./agents"
import type { palette } from "./palette"

type Palette = ReturnType<typeof palette>
type Press = (cx: Context) => void

export const zinc = {
  s1: "#1f1f22", s2: "#27272a", s3: "#3f3f46", border: "#27272a", borderAccent: "#303036",
  accent: "#e4e4e7", accentFg: "#18181b", muted: "#a1a1aa", clear: "#00000000"
} as const satisfies Readonly<Record<string, Color>>

const dotColour: Readonly<Record<CardStatus, Color>> = {
  "Awaiting you": "#db932e", Running: "#5caaf6", Queued: "#71717a", Failed: "#f7796d", Done: "#35c264"
}

const markWidth = 14

export const statusDot = (status: CardStatus): Element =>
  div().w(markWidth).h(markWidth).flex_none().flex().items_center().justify_center()
    .child(div().size(6).rounded(3).bg(dotColour[status]))

type IconName = "circle-check" | "circle-x" | "circle-alert" | "circle-dashed" | "spinner"

// Herdr App ships the spinner and circle-check with its workspace-chrome mod, and the Lucide icons it lacks ship with this mod.
const iconPaths: Readonly<Record<IconName, string>> = {
  spinner: "mods/workspace-chrome/spinner.svg",
  "circle-check": "mods/workspace-chrome/circle-check.svg",
  "circle-x": "mods/orc-agents/icons/circle-x.svg",
  "circle-alert": "mods/orc-agents/icons/circle-alert.svg",
  "circle-dashed": "mods/orc-agents/icons/circle-dashed.svg"
}

const icon = (name: IconName, size: number, colour: Color): Element => {
  const drawn = svg(iconPaths[name]).size(size).flex_none().text_color(colour)
  return name === "spinner" ? drawn.spin(900) : drawn
}

export type Vendor = "claude" | "openai"

const logoSize = 14

export const vendorLogo = (vendor: Vendor | null): Element =>
  vendor === null ? div().size(logoSize).flex_none() : image(vendor === "claude" ? "icons/claude.svg" : "icons/codex.svg").w(logoSize).h(logoSize).flex_none()

const tw = { red400: "#ff6467", amber500: "#fe9a00", emerald400: "#00d492", emerald500: "#00bc7d", blue400: "#51a2ff", blue500: "#2b7fff", error: "#fb414a" } as const

export type CheckState = "running" | "passed" | "failed"

const checkLook: Readonly<Record<CheckState, { readonly name: IconName; readonly colour: Color }>> = {
  running: { name: "spinner", colour: tw.blue400 },
  passed: { name: "circle-check", colour: tw.emerald400 },
  failed: { name: "circle-x", colour: tw.red400 }
}

export const checkIcon = (state: CheckState): Element => icon(checkLook[state].name, 14, checkLook[state].colour)

export type ControlSize = 24 | 32
export type ButtonLook = "primary" | "secondary" | "ghost"

const pill = (id: string, label: string, size: ControlSize): Element =>
  h_flex().id(id).h(size).px(size === 32 ? 16 : 10).flex_none().items_center().justify_center().gap(6).rounded(size / 2).border(1)
    .text_size(size === 32 ? 13 : 12).font_weight(500).child(label)

const looks: Readonly<Record<ButtonLook, (made: Element, fg: Color) => Element>> = {
  primary: (made) => made.border_color(zinc.accent).bg(zinc.accent).text_color(zinc.accentFg),
  secondary: (made, fg) => made.border_color(zinc.s3).bg(zinc.s3).text_color(fg),
  ghost: (made, fg) => made.border_color(zinc.clear).text_color(fg)
}

export const button = (t: Palette, id: string, label: string, look: ButtonLook, size: ControlSize, press: Press | null): Element => {
  const made = looks[look](pill(id, label, size), t.foreground)
  if (press === null) return made.opacity(0.5)
  const hovered = look === "ghost" ? made.hover((style) => style.bg(zinc.s2)) : made.hover((style) => style.opacity(0.85))
  return hovered.cursor_pointer().on_click((_event, cx) => press(cx))
}

export const field = (state: InputState, size: ControlSize): Element =>
  div().flex_1().min_w_0().h(size).rounded(8).border(1).border_color(zinc.clear).bg(zinc.s2).px(size === 32 ? 12 : 8)
    .flex().items_center().text_size(size === 32 ? 13 : 12)
    .hover((style) => style.border_color(zinc.borderAccent))
    .child(Input.new(state).w_full())

export const fieldWithButton = (state: InputState, action: Element): Element =>
  h_flex().gap(8).items_center().min_w_0().child(field(state, 32)).child(action)

export const selectTrigger = (t: Palette, id: string, label: string, size: ControlSize, width: number, press: Press): Element =>
  h_flex().id(id).w(width).h(size).px(size === 32 ? 12 : 10).flex_none().items_center().gap(6).rounded(8).bg(zinc.s2).text_size(size === 32 ? 13 : 12).text_color(t.foreground)
    .cursor_pointer().hover((style) => style.bg(zinc.s3)).tooltip(label)
    .on_mouse_down("left", (_event, cx) => press(cx))
    .child(div().flex_1().min_w_0().truncate().child(label)).child(div().text_color(zinc.muted).child("▾"))

export const card = (): Element => v_flex().rounded(12).border(1).border_color(zinc.border).bg(zinc.s1)

export const kbd = (t: Palette, key: string): Element =>
  div().h(20).min_w(20).px(4).flex_none().flex().items_center().justify_center().rounded(4).bg(zinc.s3)
    .text_size(12).font_weight(500).text_color(t.foreground).child(key)

export const radio = (checked: boolean): Element =>
  checked
    ? div().id("radio-checked").size(16).flex_none().rounded(8).bg(zinc.accent).flex().items_center().justify_center().child(div().size(6).rounded(3).bg(zinc.accentFg))
    : div().id("radio").size(16).flex_none().rounded(8).border(1).border_color(zinc.s3).bg(zinc.s2)

export const tab = (t: Palette, id: string, label: string, on: boolean, press: Press | null): Element => {
  const made = h_flex().id(id).h(28).px(12).flex_none().items_center().rounded(14).text_size(13).font_weight(500)
    .text_color(press === null ? t.dim : on ? t.foreground : zinc.muted)
    .when(on, (el) => el.bg(zinc.s2))
    .child(label)
  return press === null ? made : made.cursor_pointer().hover((style) => style.text_color(t.foreground)).on_click((_event, cx) => press(cx))
}

type AlertTone = "neutral" | "info" | "warning" | "error" | "success"

const alertLook: Readonly<Record<AlertTone, { readonly bg: Color; readonly icon: IconName; readonly colour: Color }>> = {
  neutral: { bg: "#ffffff0f", icon: "circle-dashed", colour: zinc.muted },
  info: { bg: `${tw.blue500}29`, icon: "spinner", colour: tw.blue400 },
  warning: { bg: `${tw.amber500}29`, icon: "circle-alert", colour: tw.amber500 },
  error: { bg: `${tw.error}29`, icon: "circle-x", colour: tw.error },
  success: { bg: `${tw.emerald500}29`, icon: "circle-check", colour: tw.emerald400 }
}

const alertIcon = 16
const alertGap = 10

export interface AlertAction {
  readonly id: string
  readonly label: string
  readonly press: Press
}

export interface AlertShown {
  readonly tone: AlertTone
  readonly title: string
  readonly body?: string
  readonly actions?: ReadonlyArray<AlertAction>
}

export const alert = (t: Palette, id: string, shown: AlertShown): Element => {
  const look = alertLook[shown.tone]
  const actions = shown.actions ?? []
  return v_flex().id(id).gap(4).px(14).py(12).rounded(12).bg(look.bg).text_size(13).min_w_0().flex_shrink_0()
    .child(h_flex().gap(alertGap).items_center()
      .child(icon(look.icon, alertIcon, look.colour))
      .child(div().flex_1().min_w_0().font_weight(700).text_color(t.foreground).whitespace_normal().child(shown.title)))
    .children(shown.body === undefined ? [] : [div().pl(alertIcon + alertGap).text_color(t.foreground).whitespace_normal().child(shown.body)])
    .children(actions.length === 0 ? [] : [h_flex().pt(8).gap(8).justify_end()
      .children(actions.map((action, index) => button(t, action.id, action.label, index === actions.length - 1 ? "primary" : "secondary", 32, action.press)))])
}
