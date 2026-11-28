import type { Color } from "gpui-kit"
import { settings, theme, themes } from "herdr"
import { type Palette, resolvePalette } from "./palette-values"

const linkColors = {
  dark: { link: "#74ade8", linkHover: "#a8d1ff", linkFocusForeground: "#0d1117" },
  light: { link: "#00458f", linkHover: "#002f66", linkFocusForeground: "#ffffff" }
} as const satisfies Record<"dark" | "light", Record<"link" | "linkHover" | "linkFocusForeground", Color>>

const activeThemeIsLight = (): boolean => {
  const name = settings()["theme"]
  return typeof name === "string" && themes().find((entry) => entry.name === name)?.light === true
}

export const linkPalette = (surface: "theme" | "card"): (typeof linkColors)["dark" | "light"] =>
  surface === "theme" && activeThemeIsLight() ? linkColors.light : linkColors.dark

export const palette = (): Palette => resolvePalette(theme())
