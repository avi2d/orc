import type { Theme } from "vitepress"
import DefaultTheme from "vitepress/theme"
import { MermaidDiagram } from "./mermaid-diagram"
import "../../diagrams/diagram.css"
import "./custom.css"

export default {
  extends: DefaultTheme,
  enhanceApp: ({ app }) => {
    app.component("MermaidDiagram", MermaidDiagram)
  }
} satisfies Theme
