<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from "vue"
import { BaseEdge, EdgeLabelRenderer, Handle, MarkerType, Position, VueFlow, useVueFlow, type Edge, type Node } from "@vue-flow/core"
import "@vue-flow/core/dist/style.css"
import { useData } from "vitepress"
import MapShell from "./MapShell.vue"
import PartCard from "./PartCard.vue"
import { layoutMap, type MapLayout, type PlacedLabel } from "./layout"
import { childrenOf, folds, links, parts, pathTo, shownLinks, titleOf, type MapPart } from "./orc-map"
import { roundedPath } from "./route"

const readable = 0.8
const around = 120
const groups = childrenOf(undefined).map((part) => part.id)
const labelTexts = [...new Set(links.flatMap((link) => (link.label === undefined ? [] : [link.label])))]
const open = ref<ReadonlySet<string>>(new Set(groups))
const phone = ref(false)
const cardWidth = computed(() => (phone.value ? 168 : 196))
const measure = ref<HTMLElement>()
const placed = shallowRef<MapLayout>({ parts: [], links: [], bounds: { x: 0, y: 0, width: 0, height: 0 } })
const hovered = ref<string>()
const { isDark } = useData()
const { setViewport } = useVueFlow("orc-map")

const nodes = computed(() =>
  placed.value.parts.map(
    (item): Node<{ part: MapPart; open: boolean; depth: number }> => ({
      id: item.part.id,
      type: "part",
      position: { x: item.rect.x, y: item.rect.y },
      data: { part: item.part, open: item.open, depth: item.depth },
      zIndex: item.open ? item.depth : 1000,
      style: { width: item.rect.width.toString() + "px", height: item.rect.height.toString() + "px" }
    })
  )
)

const edges = computed(() => {
  const ink = { work: isDark.value ? "#f0624a" : "#a3160f", ask: isDark.value ? "#e6ac3f" : "#774d00" }
  return placed.value.links.map((item): Edge<{ path: string; label?: PlacedLabel }> => {
    const touched = hovered.value !== undefined && (item.link.from === hovered.value || item.link.to === hovered.value)
    return {
      id: item.link.from + ">" + item.link.to,
      source: item.link.from,
      target: item.link.to,
      type: "wire",
      zIndex: 500,
      class: "link-" + item.link.tone + (hovered.value === undefined ? "" : touched ? " is-lit" : " is-dim"),
      markerEnd: { type: MarkerType.ArrowClosed, color: ink[item.link.tone], width: 16, height: 16 },
      data: { path: roundedPath(item.points, 10), ...(item.label === undefined ? {} : { label: item.label }) }
    }
  })
})

const spoken = computed(() => shownLinks(open.value).map((link) => "From " + titleOf(link.from) + " to " + titleOf(link.to) + (link.label === undefined ? "" : ": " + link.label) + "."))

const measured = (name: "part" | "label"): Map<string, { width: number; height: number }> => {
  const found = new Map<string, { width: number; height: number }>()
  for (const item of measure.value?.querySelectorAll<HTMLElement>("[data-" + name + "]") ?? []) found.set(item.dataset[name] ?? "", { width: Math.ceil(item.getBoundingClientRect().width), height: item.offsetHeight })
  return found
}

const layout = async (focus?: string): Promise<void> => {
  const cards = measured("part")
  const labels = measured("label")
  placed.value = layoutMap({
    open: open.value,
    stacked: phone.value,
    cardWidth: cardWidth.value,
    cardHeight: (id) => cards.get(id)?.height ?? 80,
    labelSize: (text) => labels.get(text) ?? { width: 80, height: 16 }
  })
  await nextTick()
  const stage = measure.value?.parentElement
  const all = placed.value.bounds
  const room = { width: (stage?.clientWidth ?? 390) - 16, height: (stage?.clientHeight ?? 700) - 16 }
  const target = focus === undefined ? undefined : placed.value.parts.find((item) => item.part.id === focus)?.rect
  if (phone.value) {
    const zoom = Math.min(1, room.width / all.width)
    void setViewport({ x: 8 - all.x * zoom, y: 8 - (target?.y ?? all.y) * zoom, zoom }, { duration: 250 })
    return
  }
  const whole = Math.min(1, room.width / all.width, room.height / all.height)
  if (target === undefined || whole >= readable) {
    void setViewport({ x: 8 + (room.width - all.width * whole) / 2 - all.x * whole, y: 8 + Math.max(0, (room.height - all.height * whole) / 3) - all.y * whole, zoom: whole }, { duration: 250 })
    return
  }
  const zoom = Math.min(1, Math.max(readable, Math.min(room.width / (target.width + 2 * around), room.height / (target.height + around))))
  const left = 8 + (room.width - target.width * zoom) / 2 - target.x * zoom
  const top = 8 + Math.max(around / 2, (room.height - target.height * zoom) / 2) - target.y * zoom
  void setViewport({ x: left, y: top, zoom }, { duration: 250 })
}

const toggle = (id: string): void => {
  const opening = !open.value.has(id)
  const path = pathTo(id)
  const next = new Set(open.value)
  if (opening) next.add(id)
  else next.delete(id)
  open.value = next
  void nextTick(() => layout(opening ? id : path.at(-2)))
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
  void document.fonts.ready.then(onWidth)
})
onBeforeUnmount(() => narrow?.removeEventListener("change", onWidth))
</script>

<template>
  <MapShell @open-all="setAll(parts.filter((part) => folds(part.id)).map((part) => part.id))" @fold-all="setAll(groups)">
    <div ref="measure" class="map-measure" aria-hidden="true" inert>
      <div v-for="part in parts" :key="part.id" :data-part="part.id" :style="{ width: cardWidth + 'px' }">
        <PartCard :part="part" :folds="part.inside !== undefined && folds(part.id)" :open="false" />
      </div>
      <span v-for="label in labelTexts" :key="label" class="map-label" :data-label="label">{{ label }}</span>
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
      :min-zoom="0.2"
      :max-zoom="2"
      aria-label="How orc works, as a map that folds"
      @node-mouse-enter="hovered = $event.node.data.open || !hovers ? undefined : $event.node.id"
      @node-mouse-leave="hovered = undefined"
    >
      <template #node-part="{ id, data }">
        <PartCard :part="data.part" :folds="data.part.inside !== undefined && folds(id)" :open="data.open" :depth="data.depth" @toggle="toggle(id)" />
        <Handle type="source" :position="Position.Bottom" :connectable="false" />
        <Handle type="target" :position="Position.Top" :connectable="false" />
      </template>
      <template #edge-wire="{ data, markerEnd, source, target }">
        <BaseEdge :path="data.path" :marker-end="markerEnd" />
        <EdgeLabelRenderer v-if="data.label">
          <span
            class="map-label is-placed"
            :class="{ 'is-dim': hovered !== undefined && hovered !== source && hovered !== target }"
            :style="{ transform: 'translate(' + data.label.rect.x + 'px,' + data.label.rect.y + 'px)', width: data.label.rect.width + 'px' }"
            aria-hidden="true"
            >{{ data.label.text }}</span
          >
        </EdgeLabelRenderer>
      </template>
    </VueFlow>
    <section class="sr" aria-label="The arrows on the map">
      <ul>
        <li v-for="line in spoken" :key="line">{{ line }}</li>
      </ul>
    </section>
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
.map-label {
  display: inline-block;
  box-sizing: border-box;
  max-width: 96px;
  color: var(--m-ink);
  font-size: 11.5px;
  font-weight: 600;
  line-height: 1.25;
}
.map-measure .map-label {
  display: table;
}
.map-label.is-placed {
  position: absolute;
  top: 0;
  left: 0;
  max-width: none;
  border-radius: 3px;
  background: var(--m-under-label);
  box-shadow: 0 0 0 2px var(--m-under-label);
  pointer-events: none;
  transition: opacity 0.15s ease;
}
.map-label.is-dim {
  opacity: 0.25;
}
.orc-map .vue-flow {
  position: absolute;
  inset: 0;
}
.orc-map .vue-flow__node {
  transition: transform 0.25s ease, width 0.25s ease, height 0.25s ease;
}
.orc-map .vue-flow__edge-labels {
  z-index: 1001;
}
.orc-map .vue-flow__handle {
  opacity: 0;
  pointer-events: none;
}
.orc-map .vue-flow__edge-path {
  stroke-width: 1.75;
}
.orc-map .link-work .vue-flow__edge-path { stroke: var(--m-work); }
.orc-map .link-ask .vue-flow__edge-path { stroke: var(--m-ask); stroke-dasharray: 5 4; }
.orc-map .vue-flow__edge { transition: opacity 0.15s ease; }
.orc-map .vue-flow__edge.is-dim { opacity: 0.18; }
.orc-map .vue-flow__edge.is-lit .vue-flow__edge-path { stroke-width: 2.75; }
@media (prefers-reduced-motion: reduce) {
  .orc-map .vue-flow__node { transition: none; }
}
</style>
