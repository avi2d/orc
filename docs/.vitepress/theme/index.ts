import type { Theme } from "vitepress"
import DefaultTheme from "vitepress/theme"
import "@fontsource/alfa-slab-one/latin-400.css"
import "@fontsource-variable/jetbrains-mono/wght.css"
import "../../diagrams/diagram.css"
import "./custom.css"

export default {
  extends: DefaultTheme
} satisfies Theme
