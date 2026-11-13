import type { Color } from "gpui-kit"
import { theme } from "herdr"

type ColorName =
  | "background" | "surface" | "chrome" | "raised" | "hover" | "selected" | "border"
  | "foreground" | "muted" | "dim" | "accent" | "working" | "blocked" | "done" | "ansi1"

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
    ansi1: pick("ansi1")
  }
}
