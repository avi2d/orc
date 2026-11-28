import type { Color } from "gpui-kit"
import { settings, theme } from "herdr"

type ColorName =
  | "background" | "surface" | "chrome" | "raised" | "hover" | "selected" | "border"
  | "foreground" | "muted" | "dim" | "accent" | "working" | "blocked" | "done" | "ansi1" | "ansi2" | "solid" | "solid_foreground"

const linkColors = {
  dark: { link: "#74ade8", linkHover: "#a8d1ff", linkFocusForeground: "#0d1117" },
  light: { link: "#00458f", linkHover: "#002f66", linkFocusForeground: "#ffffff" }
} as const satisfies Record<"dark" | "light", Record<"link" | "linkHover" | "linkFocusForeground", Color>>

export const linkPalette = (): (typeof linkColors)["dark" | "light"] => settings().dark === false ? linkColors.light : linkColors.dark

const isColor = (value: string | undefined): value is Color => value?.startsWith("#") === true

export const palette = (): Readonly<Record<ColorName, Color>> => {
  const colors = theme()
  const pick = (name: ColorName): Color => {
    const value = colors[name]
    return isColor(value) ? value : "#808080"
  }
  return {
    background: pick("background"),
    surface: pick("surface"),
    chrome: pick("chrome"),
    raised: pick("raised"),
    hover: pick("hover"),
    selected: pick("selected"),
    border: pick("border"),
    foreground: pick("foreground"),
    muted: pick("muted"),
    dim: pick("dim"),
    accent: pick("accent"),
    working: pick("working"),
    blocked: pick("blocked"),
    done: pick("done"),
    ansi1: pick("ansi1"),
    ansi2: pick("ansi2"),
    solid: pick("solid"),
    solid_foreground: pick("solid_foreground")
  }
}
