import { defineComponent, h, onMounted, ref, watch } from "vue"
import { useData } from "vitepress"

let drawn = 0

export const MermaidDiagram = defineComponent({
  name: "MermaidDiagram",
  props: { code: { type: String, required: true } },
  setup: (props) => {
    const { isDark } = useData()
    const source = decodeURIComponent(props.code)
    const svg = ref("")
    const draw = (): void => {
      drawn += 1
      const id = "mermaid-diagram-" + drawn.toString()
      void import("mermaid")
        .then(({ default: mermaid }) => {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            theme: isDark.value ? "dark" : "neutral",
            fontFamily: "inherit",
            flowchart: { useMaxWidth: true, htmlLabels: true, curve: "basis" }
          })
          return mermaid.render(id, source)
        })
        .then((rendered) => {
          svg.value = rendered.svg
        })
    }
    onMounted(draw)
    watch(isDark, draw)
    return () =>
      svg.value === ""
        ? h("pre", { class: "mermaid-diagram mermaid-diagram-source" }, source)
        : h("div", { class: "mermaid-diagram", role: "img", innerHTML: svg.value })
  }
})
