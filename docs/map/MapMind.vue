<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue"
import { Markmap } from "markmap-view"
import { withBase } from "vitepress"
import MapShell from "./MapShell.vue"
import { childrenOf, mapTitle, type MapPart } from "./orc-map"

interface Branch {
  content: string
  children: Branch[]
  payload?: { fold?: number }
}

const svg = ref<SVGSVGElement>()
let map: Markmap | undefined

const escape = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

const branch = (part: MapPart, depth: number): Branch => {
  const children = [...childrenOf(part.id).map((child) => branch(child, depth + 1)), ...(part.points ?? []).map((point) => ({ content: escape(point), children: [] }))]
  const page = part.page === undefined ? "" : ' <a href="' + withBase("/" + part.page) + '">Read the page</a>'
  return {
    content: "<strong" + (part.mono ? ' class="mono"' : "") + ">" + escape(part.title) + "</strong>" + (part.text === undefined ? "" : "<br>" + escape(part.text)) + page,
    children,
    payload: { fold: depth >= 2 && children.length > 0 ? 1 : 0 }
  }
}

const tree = (): Branch => ({ content: "<strong>" + mapTitle + "</strong>", children: childrenOf(undefined).map((group) => branch(group, 1)) })

const setAll = (folded: boolean): void => {
  const walk = (node: Branch, depth: number): Branch => ({ ...node, children: node.children.map((child) => walk(child, depth + 1)), payload: { fold: folded && depth >= 2 && node.children.length > 0 ? 1 : 0 } })
  void map?.setData(walk(tree(), 0)).then(() => map?.fit())
}

const onPress = (event: MouseEvent): void => {
  const target = event.target instanceof Element ? event.target : undefined
  if (target === undefined || target.closest("a") !== null) return
  const node = target.closest(".markmap-foreign")?.closest<SVGGElement & { __data__?: Parameters<Markmap["toggleNode"]>[0] }>("g.markmap-node")
  const data = node?.__data__
  if (data === undefined || (data.children?.length ?? 0) === 0) return
  void map?.toggleNode(data).then(() => (window.matchMedia("(max-width: 720px)").matches ? map?.centerNode(data) : map?.fit()))
}

onMounted(() => {
  if (svg.value === undefined) return
  map = Markmap.create(svg.value, { duration: 250, maxWidth: 230, spacingVertical: 8, spacingHorizontal: 60, paddingX: 10, autoFit: false }, tree())
  svg.value.addEventListener("click", onPress)
})
onBeforeUnmount(() => {
  svg.value?.removeEventListener("click", onPress)
  map?.destroy()
})
</script>

<template>
  <MapShell draft="Draft C: markmap" @open-all="setAll(false)" @fold-all="setAll(true)">
    <svg ref="svg" class="map-mind markmap" role="img" aria-label="How orc works, as a tree that folds" />
  </MapShell>
</template>

<style>
.orc-map .map-mind {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  --markmap-text-color: var(--m-mute);
  --markmap-a-color: var(--m-work);
  --markmap-a-hover-color: var(--m-work);
  --markmap-circle-open-bg: var(--m-page);
  --markmap-font: 13px/1.4 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.orc-map .map-mind strong {
  color: var(--m-ink);
  font-weight: 650;
}
.orc-map .map-mind .mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.orc-map .map-mind .markmap-foreign {
  cursor: pointer;
}
</style>
