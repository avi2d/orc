<script setup lang="ts">
import { useData, withBase } from "vitepress"
import MapLegend from "./MapLegend.vue"
import { mapTitle } from "./orc-map"

defineEmits<{ openAll: []; foldAll: [] }>()

const { isDark } = useData()

const legendOpen = typeof window !== "undefined" && window.matchMedia("(min-width: 721px)").matches
</script>

<template>
  <div class="orc-map">
    <header class="orc-map-bar">
      <a class="map-back" :href="withBase('/')" aria-label="Back to the orc docs"><span aria-hidden="true">←</span><span class="map-back-word">Docs</span></a>
      <p class="map-title">{{ mapTitle }}</p>
      <div class="map-actions">
        <button type="button" @click="$emit('openAll')">Open all</button>
        <button type="button" @click="$emit('foldAll')">Fold all</button>
        <button type="button" :aria-pressed="isDark" @click="isDark = !isDark">{{ isDark ? "Light" : "Dark" }}</button>
      </div>
    </header>
    <main class="map-stage"><slot /></main>
    <details class="map-legend" :open="legendOpen">
      <summary>Legend</summary>
      <MapLegend />
    </details>
  </div>
</template>

<style>
.orc-map {
  --m-ink: var(--paint-ink);
  --m-mute: var(--paint-muted);
  --m-line: var(--paint-line);
  --m-card: var(--paint-surface);
  --m-zone: var(--paint-surface-2);
  --m-page: var(--paint-bg);
  --m-grain: var(--p-grain) 0 0 / 512px 512px;
  --m-under-label: color-mix(in srgb, var(--m-zone) 70%, var(--m-page));
  --m-work: var(--paint-work);
  --m-area-edge: var(--paint-area-edge);
  --m-end-soft: var(--paint-end-soft);
  --m-ask: var(--paint-ask);
  --m-ask-soft: var(--paint-ask-soft);
  --m-ok: var(--paint-ok);
  --m-ok-soft: var(--paint-ok-soft);
  position: fixed;
  inset: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  background: var(--m-page) var(--m-grain);
  color: var(--m-ink);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.orc-map-bar {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  padding-top: max(8px, env(safe-area-inset-top));
  border-bottom: 1px solid var(--m-line);
  background: var(--vp-nav-bg-color);
}
.orc-map-bar .map-back {
  justify-self: start;
}
.orc-map-bar .map-actions {
  display: flex;
  justify-self: end;
  gap: 8px;
}
.orc-map-bar .map-title {
  text-align: center;
  min-width: 0;
  margin: 0;
  font-family: var(--paint-display);
  font-size: 15px;
  font-weight: 400;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.orc-map-bar a,
.orc-map-bar button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  box-sizing: border-box;
  min-height: 36px;
  padding: 0 10px;
  border: 1px solid var(--m-line);
  border-radius: 8px;
  background: var(--m-card);
  color: var(--m-ink);
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  text-rendering: optimizeLegibility;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
}
.orc-map-bar a:focus-visible,
.orc-map-bar button:focus-visible,
.map-legend summary:focus-visible {
  outline: 2px solid var(--m-ink);
  outline-offset: 2px;
}
.map-legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 18px;
  padding: 6px 12px;
  padding-bottom: max(6px, env(safe-area-inset-bottom));
  border-top: 1px solid var(--m-line);
  background: var(--m-card);
}
.map-legend summary {
  min-height: 28px;
  font-size: 13px;
  font-weight: 600;
  line-height: 28px;
  cursor: pointer;
}
.map-legend[open] summary {
  float: left;
  margin-right: 18px;
}
.map-legend .map-key {
  min-height: 28px;
  align-items: center;
}
.map-stage {
  position: relative;
  min-height: 0;
  overflow: hidden;
}
@media (max-width: 520px) {
  .map-back-word {
    display: none;
  }
  .orc-map-bar a,
  .orc-map-bar button {
    padding: 0 8px;
  }
}
@media (max-width: 720px) {
  .orc-map-bar {
    row-gap: 4px;
  }
  .orc-map-bar .map-actions {
    grid-column: 1 / -1;
    justify-self: center;
  }
}
</style>
