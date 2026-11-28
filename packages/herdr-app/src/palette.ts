import type { Color } from "gpui-kit"
import { settings, theme } from "herdr"
import { type Palette, resolvePalette } from "./palette-values"

const linkColors = {
  dark: { link: "#74ade8", linkHover: "#a8d1ff", linkFocusForeground: "#0d1117" },
  light: { link: "#00458f", linkHover: "#002f66", linkFocusForeground: "#ffffff" }
} as const satisfies Record<"dark" | "light", Record<"link" | "linkHover" | "linkFocusForeground", Color>>

export const linkPalette = (surface: "theme" | "card"): (typeof linkColors)["dark" | "light"] =>
  surface === "card" || settings().dark ? linkColors.dark : linkColors.light

export const palette = (): Palette => resolvePalette(theme())
