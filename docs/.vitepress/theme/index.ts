import { h } from "vue"
import type { Theme } from "vitepress"
import { withBase } from "vitepress"
import DefaultTheme from "vitepress/theme"
import "../../diagrams/diagram.css"
import "./custom.css"
import "./paper.css"
import "./paper-prose.css"

const strip = () =>
  h("div", { class: "paper-strip" }, [h("img", { src: withBase("/paper/strip.webp"), alt: "", width: 2132, height: 313, loading: "lazy" })])

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { "doc-after": strip })
} satisfies Theme
