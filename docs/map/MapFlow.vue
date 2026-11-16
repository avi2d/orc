<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from "vue"
import { Handle, MarkerType, Position, VueFlow, useVueFlow, type Edge, type Node } from "@vue-flow/core"
import "@vue-flow/core/dist/style.css"
import { useData } from "vitepress"
import MapShell from "./MapShell.vue"
import PartCard from "./PartCard.vue"
import { childrenOf, folds, parts, shownLinks, type MapPart } from "./orc-map"

const groups = childrenOf(undefined).map((part) => part.id)
const open = ref<ReadonlySet<string>>(new Set(groups))
const phone = ref(false)
const cardWidth = computed(() => (phone.value ? 176 : 224))
const measure = ref<HTMLElement>()
const nodes = shallowRef<Node<{ part: MapPart }>[]>([])
const drawnEdges = shallowRef<Edge[]>([])
const hovered = ref<string>()
const edges = computed(() =>
  hovered.value === undefined
    ? drawnEdges.value
    : drawnEdges.value.map((link) => ({ ...link, class: String(link.class) + (link.source === hovered.value || link.target === hovered.value ? " is-lit" : " is-dim") }))
)
const { isDark } = useData()
const { fitView, setViewport } = useVueFlow("orc-map")

const sides = [Position.Top, Position.Right, Position.Bottom, Position.Left]

const isOpen = (id: string): boolean => open.value.has(id) && folds(id)

const heights = (): Map<string, number> => {
  const found = new Map<string, number>()
  for (const card of measure.value?.querySelectorAll<HTMLElement>("[data-part]") ?? []) found.set(card.dataset["part"] ?? "", card.offsetHeight)
  return found
}

type Placed = Node<{ part: MapPart }>
interface Box {
  readonly width: number
  readonly height: number
  readonly nodes: readonly Placed[]
}

const byId = new Map(parts.map((part) => [part.id, part]))

const ancestors = (id: string): readonly string[] => {
  const chain: string[] = []
  for (let part = byId.get(id); part !== undefined; part = part.inside === undefined ? undefined : byId.get(part.inside)) chain.unshift(part.id)
  return chain
}

const across = new Set(["plans"])
const headRoom = 40
const edge = 12

const layout = async (focus?: string): Promise<void> => {
  const { default: Elk } = await import("elkjs/lib/elk.bundled.js")
  const elk = new Elk()
  const cardHeights = heights()
  const shown = shownLinks(open.value)

  const place = async (part: MapPart): Promise<Box> => {
    if (!isOpen(part.id)) return { width: cardWidth.value, height: cardHeights.get(part.id) ?? 80, nodes: [] }
    const inner = childrenOf(part.id)
    const boxes = new Map<string, Box>()
    for (const child of inner) boxes.set(child.id, await place(child))
    const depth = ancestors(part.id).length
    const childOf = (id: string): string | undefined => {
      const chain = ancestors(id)
      return chain[depth - 1] === part.id ? chain[depth] : undefined
    }
    const seen = new Set<string>()
    const between = shown.flatMap((link) => {
      const from = childOf(link.from)
      const to = childOf(link.to)
      if (from === undefined || to === undefined || from === to || seen.has(from + ">" + to) || seen.has(to + ">" + from)) return []
      seen.add(from + ">" + to)
      return [{ id: from + ">" + to, sources: [from], targets: [to] }]
    })
    if (between.length === 0) return stack(part, inner, boxes)
    const drawn = await elk.layout({
      id: part.id,
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": across.has(part.id) ? "RIGHT" : "DOWN",
        "elk.padding": "[top=" + headRoom.toString() + ",left=" + edge.toString() + ",bottom=" + edge.toString() + ",right=" + edge.toString() + "]",
        "elk.layered.spacing.nodeNodeBetweenLayers": "34",
        "elk.spacing.nodeNode": "12",
        "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES"
      },
      children: inner.map((child) => ({ id: child.id, width: boxes.get(child.id)?.width ?? 0, height: boxes.get(child.id)?.height ?? 0 })),
      edges: between
    })
    const nodes = (drawn.children ?? []).flatMap((child): Placed[] => {
      const childPart = byId.get(child.id)
      const box = boxes.get(child.id)
      if (childPart === undefined || box === undefined) return []
      return [node(childPart, child.x ?? 0, child.y ?? 0, box, part.id), ...box.nodes]
    })
    return { width: drawn.width ?? 0, height: drawn.height ?? 0, nodes }
  }

  const stack = (part: MapPart, inner: readonly MapPart[], boxes: ReadonlyMap<string, Box>): Box => {
    let top = headRoom
    const nodes = inner.flatMap((child): Placed[] => {
      const box = boxes.get(child.id)
      if (box === undefined) return []
      const placedChild = node(child, edge, top, box, part.id)
      top += box.height + 12
      return [placedChild, ...box.nodes]
    })
    const widest = Math.max(...inner.map((child) => boxes.get(child.id)?.width ?? 0))
    return { width: widest + edge * 2, height: top - 12 + edge, nodes }
  }

  const node = (part: MapPart, x: number, y: number, box: Box, parent?: string): Placed => ({
    id: part.id,
    type: "part",
    position: { x, y },
    data: { part },
    zIndex: isOpen(part.id) ? ancestors(part.id).length : 1000,
    style: { width: box.width.toString() + "px", height: box.height.toString() + "px" },
    ...(parent === undefined ? {} : { parentNode: parent })
  })

  const placed: Placed[] = []
  let offset = 0
  for (const group of childrenOf(undefined)) {
    const box = await place(group)
    placed.push(node(group, phone.value ? 0 : offset, phone.value ? offset : 0, box), ...box.nodes)
    offset += (phone.value ? box.height : box.width) + (phone.value ? 28 : 52)
  }
  nodes.value = placed

  const centre = new Map<string, { x: number; y: number; halfWidth: number; halfHeight: number }>()
  for (const item of placed) {
    const parent = item.parentNode === undefined ? undefined : centre.get(item.parentNode)
    const width = Number.parseFloat(String(item.style && "width" in item.style ? item.style.width : 0))
    const height = Number.parseFloat(String(item.style && "height" in item.style ? item.style.height : 0))
    const left = item.position.x + (parent === undefined ? 0 : parent.x - parent.halfWidth)
    const top = item.position.y + (parent === undefined ? 0 : parent.y - parent.halfHeight)
    centre.set(item.id, { x: left + width / 2, y: top + height / 2, halfWidth: width / 2, halfHeight: height / 2 })
  }
  const ink = { work: isDark.value ? "#a8b1ff" : "#3451b2", ask: isDark.value ? "#e9b949" : "#8a5a00" }
  drawnEdges.value = shown.flatMap((link): Edge[] => {
    const from = centre.get(link.from)
    const to = centre.get(link.to)
    if (from === undefined || to === undefined) return []
    const gapX = Math.abs(to.x - from.x) - from.halfWidth - to.halfWidth
    const gapY = Math.abs(to.y - from.y) - from.halfHeight - to.halfHeight
    const sideways = gapX > 0 && gapX >= gapY
    const forward = sideways ? to.x > from.x : to.y > from.y
    const returns = shown.some((other) => other.from === link.to && other.to === link.from) && link.tone === "ask"
    const loop = sideways ? "top" : "left"
    return [
      {
        id: link.from + ">" + link.to,
        source: link.from,
        target: link.to,
        sourceHandle: returns ? loop : sideways ? (forward ? "right" : "left") : forward ? "bottom" : "top",
        targetHandle: returns ? loop : sideways ? (forward ? "left" : "right") : forward ? "top" : "bottom",
        type: "smoothstep",
        zIndex: 500,
        class: "link-" + link.tone,
        markerEnd: { type: MarkerType.ArrowClosed, color: ink[link.tone], width: 18, height: 18 },
        ...(link.label === undefined ? {} : { label: link.label })
      }
    ]
  })
  await nextTick()
  window.setTimeout(() => {
    if (!phone.value) {
      void fitView({ padding: 0.03, maxZoom: 1, minZoom: 0.5, duration: 250 })
      return
    }
    const stage = measure.value?.parentElement?.clientWidth ?? 390
    const target = focus === undefined ? undefined : centre.get(focus)
    const widest = Math.max(...[...centre.values()].map((box) => box.x + box.halfWidth))
    const zoom = Math.min(1, Math.max(0.6, (stage - 16) / (target === undefined ? widest : target.halfWidth * 2)))
    void setViewport({ x: 8 - (target === undefined ? 0 : target.x - target.halfWidth) * zoom, y: 8 - (target === undefined ? 0 : target.y - target.halfHeight) * zoom, zoom }, { duration: 250 })
  }, 40)
}

const toggle = (id: string): void => {
  const next = new Set(open.value)
  const opening = !next.delete(id)
  if (opening) next.add(id)
  open.value = next
  void nextTick(() => layout(opening ? id : undefined))
}

const setAll = (ids: readonly string[]): void => {
  open.value = new Set(ids)
  void nextTick(() => layout())
}

const hovers = typeof window !== "undefined" && window.matchMedia("(hover: hover)").matches
const narrow = typeof window === "undefined" ? undefined : window.matchMedia("(max-width: 720px)")
const onWidth = (): void => {
  phone.value = narrow?.matches ?? false
  void nextTick(() => layout())
}

onMounted(() => {
  narrow?.addEventListener("change", onWidth)
  onWidth()
})
onBeforeUnmount(() => narrow?.removeEventListener("change", onWidth))
</script>

<template>
  <MapShell draft="Draft A: Vue Flow with an ELK layout" @open-all="setAll(parts.filter((part) => folds(part.id)).map((part) => part.id))" @fold-all="setAll(groups)">
    <div ref="measure" class="map-measure" aria-hidden="true" inert>
      <div v-for="part in parts" :key="part.id" :data-part="part.id" :style="{ width: cardWidth + 'px' }">
        <PartCard :part="part" :folds="folds(part.id)" :open="false" />
      </div>
    </div>
    <VueFlow
      id="orc-map"
      :nodes="nodes"
      :edges="edges"
      :nodes-draggable="false"
      :nodes-connectable="false"
      :nodes-focusable="false"
      :edges-focusable="false"
      :elements-selectable="false"
      connection-mode="loose"
      @node-mouse-enter="hovered = isOpen($event.node.id) || !hovers ? undefined : $event.node.id"
      @node-mouse-leave="hovered = undefined"
      :min-zoom="0.2"
      :max-zoom="2"
      aria-label="How orc works, as a map that folds"
    >
      <template #node-part="{ id, data }">
        <PartCard :part="data.part" :folds="folds(id)" :open="isOpen(id)" @toggle="toggle(id)" />
        <Handle v-for="side in sides" :id="side" :key="side" type="source" :position="side" :connectable="false" />
      </template>
    </VueFlow>
  </MapShell>
</template>

<style>
.map-measure {
  position: absolute;
  visibility: hidden;
  pointer-events: none;
}
.map-measure .part {
  height: auto;
}
.orc-map .vue-flow {
  position: absolute;
  inset: 0;
}
.orc-map .vue-flow__node {
  transition: transform 0.25s ease, width 0.25s ease, height 0.25s ease;
}
.orc-map .vue-flow__handle {
  opacity: 0;
  pointer-events: none;
}
.orc-map .vue-flow__edge-path {
  stroke-width: 2;
}
.orc-map .link-work .vue-flow__edge-path { stroke: var(--m-work); }
.orc-map .link-ask .vue-flow__edge-path { stroke: var(--m-ask); stroke-dasharray: 5 4; }
.orc-map .vue-flow__edge { transition: opacity 0.15s ease; }
.orc-map .vue-flow__edge.is-dim { opacity: 0.18; }
.orc-map .vue-flow__edge.is-lit .vue-flow__edge-path { stroke-width: 3; }
.orc-map .vue-flow__edge-textbg { fill: var(--m-page); }
.orc-map .vue-flow__edge-text { fill: var(--m-ink); font-size: 11.5px; font-weight: 600; }
@media (prefers-reduced-motion: reduce) {
  .orc-map .vue-flow__node { transition: none; }
}
</style>
