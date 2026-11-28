import { theme } from "herdr"
import { type Palette, resolvePalette } from "./palette-values"

export const palette = (): Palette => resolvePalette(theme())
