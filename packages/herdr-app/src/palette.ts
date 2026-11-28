import type { Color } from "gpui-kit"
import { settings, theme } from "herdr"
import { type Palette, resolvePalette } from "./palette-values"

const linkColors = {
  dark: { link: "#74ade8", linkHover: "#a8d1ff", linkFocusForeground: "#0d1117" },
  light: { link: "#00458f", linkHover: "#002f66", linkFocusForeground: "#ffffff" }
} as const satisfies Record<"dark" | "light", Record<"link" | "linkHover" | "linkFocusForeground", Color>>

export const linkPalette = (): (typeof linkColors)["dark" | "light"] => settings().dark === false ? linkColors.light : linkColors.dark

export const palette = (): Palette => resolvePalette(theme())
