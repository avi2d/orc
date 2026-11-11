import type { Color } from "gpui-kit"
import { theme } from "herdr"

type ColorName = "surface" | "chrome" | "raised" | "hover" | "foreground" | "muted" | "dim" | "blocked"

const isColor = (value: string | undefined): value is Color => value?.startsWith("#") === true

export const palette = (): Readonly<Record<ColorName, Color>> => {
  const colors = theme()
  const pick = (name: ColorName): Color => {
    const value = colors[name]
    return isColor(value) ? value : "#808080"
  }
  return {
    surface: pick("surface"),
    chrome: pick("chrome"),
    raised: pick("raised"),
    hover: pick("hover"),
    foreground: pick("foreground"),
    muted: pick("muted"),
    dim: pick("dim"),
    blocked: pick("blocked")
  }
}
