import type { Color } from "gpui-kit"
import { theme } from "herdr"
import { type Palette, resolvePalette } from "./palette-values"

const linkColors = {
  dark: { link: "#74ade8", linkHover: "#a8d1ff", linkFocusForeground: "#0d1117" },
  light: { link: "#00458f", linkHover: "#002f66", linkFocusForeground: "#ffffff" }
} as const satisfies Record<"dark" | "light", Record<"link" | "linkHover" | "linkFocusForeground", Color>>

const channel = (color: string, at: number): number => {
  const value = Number.parseInt(color.slice(at, at + 2), 16) / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

const luminance = (color: string): number => 0.2126 * channel(color, 1) + 0.7152 * channel(color, 3) + 0.0722 * channel(color, 5)

const contrast = (first: number, second: number): number =>
  (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)

const isRgb = (value: string | undefined): value is string => value !== undefined && /^#[0-9a-f]{6}$/i.test(value)

const weakestContrast = (colors: (typeof linkColors)["dark" | "light"], background: number): number =>
  Math.min(contrast(luminance(colors.link), background), contrast(luminance(colors.linkHover), background))

const themeLinks = (): (typeof linkColors)["dark" | "light"] => {
  const background = theme()["background"]
  if (!isRgb(background)) return linkColors.dark
  const surface = luminance(background)
  return weakestContrast(linkColors.light, surface) > weakestContrast(linkColors.dark, surface) ? linkColors.light : linkColors.dark
}

export const linkPalette = (surface: "theme" | "card"): (typeof linkColors)["dark" | "light"] =>
  surface === "theme" ? themeLinks() : linkColors.dark

export const palette = (): Palette => resolvePalette(theme())
