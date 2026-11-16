<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue"
import cytoscape from "cytoscape"
import dagre from "cytoscape-dagre"
import expandCollapse from "cytoscape-expand-collapse"
import { useData, withBase } from "vitepress"
import MapShell from "./MapShell.vue"
import { childrenOf, folds, links, parts, type MapPart } from "./orc-map"

const host = ref<HTMLElement>()
const { isDark } = useData()
const groups = new Set(childrenOf(undefined).map((part) => part.id))
const cardWidth = 210
const lineHeight = 16

const palette = (dark: boolean) => ({
  ink: dark ? "#e8eaed" : "#1f2328",
  line: dark ? "#474d57" : "#c8cdd5",
  card: dark ? "#22252b" : "#ffffff",
  zone: dark ? "#17191d" : "#f3f4f6",
  page: dark ? "#101114" : "#fbfbfc",
  work: dark ? "#a8b1ff" : "#3451b2",
  workSoft: dark ? "#272c52" : "#e8ebfc",
  ask: dark ? "#e9b949" : "#8a5a00",
  askSoft: dark ? "#3a300f" : "#fff3d1",
  ok: dark ? "#48d597" : "#17794c",
  okSoft: dark ? "#12301f" : "#def5e8"
})

const font = '12px Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'

const lineCount = (pen: CanvasRenderingContext2D, text: string, width: number): number => {
  let lines = 1
  let line = ""
  for (const word of text.split(" ")) {
    const next = line === "" ? word : line + " " + word
    if (pen.measureText(next).width > width && line !== "") {
      lines += 1
      line = word
    } else line = next
  }
  return lines
}

const label = (part: MapPart): string => [part.title.toUpperCase(), ...(part.text === undefined ? [] : [part.text]), ...(part.points ?? []).map((point) => "• " + point)].join("\n")

const style = (dark: boolean): cytoscape.StylesheetJson => {
  const tint = palette(dark)
  return [
    {
      selector: "node",
      style: {
        shape: "round-rectangle",
        width: cardWidth,
        height: "data(height)",
        label: "data(label)",
        "font-family": "Inter, ui-sans-serif, system-ui, sans-serif",
        "font-size": 12,
        "line-height": 1.3,
        color: tint.ink,
        "text-wrap": "wrap",
        "text-max-width": (cardWidth - 24).toString() + "px",
        "text-valign": "center",
        "text-halign": "center",
        "text-justification": "left",
        "background-color": tint.card,
        "border-width": 1,
        "border-color": tint.line
      }
    },
    { selector: 'node[tone = "work"]', style: { "background-color": tint.workSoft, "border-color": tint.work } },
    { selector: 'node[tone = "ask"]', style: { "background-color": tint.askSoft, "border-color": tint.ask } },
    { selector: 'node[tone = "ok"]', style: { "background-color": tint.okSoft, "border-color": tint.ok } },
    {
      selector: "node:parent",
      style: { label: "data(title)", "font-size": 13, "font-weight": 700, "text-valign": "top", "text-margin-y": -4, "background-color": tint.zone, "border-color": tint.line, "border-style": "dashed", padding: "14px" }
    },
    {
      selector: "edge",
      style: {
        width: 2,
        "curve-style": "bezier",
        "line-color": tint.work,
        "target-arrow-color": tint.work,
        "target-arrow-shape": "triangle",
        label: "data(label)",
        "font-size": 10.5,
        "font-weight": 600,
        color: tint.ink,
        "text-background-color": tint.page,
        "text-background-opacity": 1,
        "text-background-padding": "2px"
      }
    },
    { selector: 'edge[tone = "ask"]', style: { "line-color": tint.ask, "target-arrow-color": tint.ask, "line-style": "dashed" } },
    { selector: "edge.cy-expand-collapse-meta-edge", style: { label: "" } }
  ]
}

let cy: cytoscape.Core | undefined
let fold: { collapse: (nodes: cytoscape.NodeCollection) => void; expand: (nodes: cytoscape.NodeCollection) => void; collapseAll: () => void; expandAll: () => void; isCollapsible: (node: cytoscape.NodeSingular) => boolean; isExpandable: (node: cytoscape.NodeSingular) => boolean } | undefined

onMounted(() => {
  const pen = document.createElement("canvas").getContext("2d")
  if (pen === null || host.value === undefined) return
  pen.font = font
  cytoscape.use(dagre)
  expandCollapse(cytoscape)
  const phone = window.matchMedia("(max-width: 720px)").matches
  const height = (part: MapPart): number =>
    label(part)
      .split("\n")
      .reduce((sum, line) => sum + lineCount(pen, line, cardWidth - 24), 0) *
      lineHeight +
    20
  cy = cytoscape({
    container: host.value,
    minZoom: 0.2,
    maxZoom: 2,
    style: style(isDark.value),
    elements: [
      ...parts.map((part) => ({ data: { id: part.id, parent: part.inside, title: part.title, label: label(part), tone: part.tone ?? "plain", height: height(part), page: part.page } })),
      ...links.map((link) => ({ data: { id: link.from + ">" + link.to, source: link.from, target: link.to, label: link.label ?? "", tone: link.tone } }))
    ]
  })
  fold = cy.expandCollapse({
    layoutBy: { name: "dagre", rankDir: phone ? "TB" : "LR", nodeSep: 14, rankSep: 44, fit: !phone, padding: 16, animate: true, animationDuration: 250 },
    fisheye: false,
    animate: false,
    undoable: false,
    cueEnabled: true,
    expandCollapseCuePosition: "top-left",
    expandCollapseCueSize: 14
  })
  cy.nodes(":parent").filter((node) => !groups.has(node.id())).forEach((node) => node.data("closed", true))
  fold?.collapse(cy.$("#kinds"))
  fold?.collapse(cy.nodes(":parent").filter((node) => !groups.has(node.id())))
  const readable = 0.85
  const show = (box: { x1: number; y1: number }): void => {
    cy?.animate({ zoom: readable, pan: { x: 10 - box.x1 * readable, y: 24 - box.y1 * readable } }, { duration: 200 })
  }
  let opened: cytoscape.NodeSingular | undefined
  if (phone) {
    cy.on("layoutstop", () => window.setTimeout(() => show((opened ?? cy?.elements())?.boundingBox() ?? { x1: 0, y1: 0 }), 20))
    show(cy.elements().boundingBox())
  }
  cy.on("tap", "node", (event) => {
    const node: cytoscape.NodeSingular = event.target
    opened = fold?.isExpandable(node) ? node : undefined
    if (fold?.isExpandable(node)) fold.expand(node)
    else if (fold?.isCollapsible(node) && !groups.has(node.id())) fold.collapse(node)
    else if (typeof node.data("page") === "string" && !folds(node.id())) window.location.assign(withBase("/" + String(node.data("page"))))
  })
})

watch(isDark, (dark) => cy?.style(style(dark)))
onBeforeUnmount(() => cy?.destroy())
</script>

<template>
  <MapShell draft="Draft B: Cytoscape.js with expand-collapse" @open-all="fold?.expandAll()" @fold-all="fold?.collapseAll()">
    <div ref="host" class="map-canvas" role="img" aria-label="How orc works, as a map that folds. This draft has no keyboard or screen reader path." />
  </MapShell>
</template>

<style>
.map-canvas {
  position: absolute;
  inset: 0;
}
</style>
