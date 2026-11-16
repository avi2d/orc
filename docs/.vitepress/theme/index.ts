import type { Theme } from "vitepress"
import DefaultTheme from "vitepress/theme"
import "../../diagrams/diagram.css"
import "./custom.css"

export default {
  extends: DefaultTheme
} satisfies Theme
