<script setup lang="ts">
import { useData, withBase } from "vitepress"
import { mapTitle } from "./orc-map"

defineEmits<{ openAll: []; foldAll: [] }>()

const { isDark } = useData()
</script>

<template>
  <div class="orc-map">
    <header class="orc-map-bar">
      <a class="map-back" :href="withBase('/')" aria-label="Back to the orc docs">←<span> Docs</span></a>
      <p class="map-title">{{ mapTitle }}<small>Select a part to open it</small></p>
      <button type="button" @click="$emit('openAll')">Open all</button>
      <button type="button" @click="$emit('foldAll')">Fold all</button>
      <button type="button" :aria-pressed="isDark" @click="isDark = !isDark">{{ isDark ? "Light" : "Dark" }}</button>
    </header>
    <main class="map-stage"><slot /></main>
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
  --m-work-soft: var(--paint-work-soft);
  --m-ask: var(--paint-ask);
  --m-ask-soft: var(--paint-ask-soft);
  --m-ok: var(--paint-ok);
  --m-ok-soft: var(--paint-ok-soft);
  position: fixed;
  inset: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  background: var(--m-page) var(--m-grain);
  color: var(--m-ink);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.orc-map-bar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  padding-top: max(8px, env(safe-area-inset-top));
  border-bottom: 1px solid var(--m-line);
  background: var(--m-card);
}
.orc-map-bar::after {
  content: "";
  position: absolute;
  z-index: 1;
  inset: auto 0 -5px 0;
  height: 9px;
  background: var(--p-edge);
  mask: var(--stroke-wavy) center / 100% 100% no-repeat;
  pointer-events: none;
}
.orc-map-bar .map-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-family: var(--p-display);
  font-size: 15px;
  font-weight: 400;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.orc-map-bar small {
  margin-left: 8px;
  color: var(--m-mute);
  font-size: 12px;
  font-weight: 500;
}
.orc-map-bar a,
.orc-map-bar button {
  min-height: 36px;
  padding: 0 10px;
  border: 1px solid var(--m-line);
  border-radius: 8px;
  background: var(--m-card);
  color: var(--m-ink);
  font: 600 13px/34px inherit;
  font-family: inherit;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
}
.orc-map-bar a:focus-visible,
.orc-map-bar button:focus-visible {
  outline: 2px solid var(--m-work);
  outline-offset: 2px;
}
.map-stage {
  position: relative;
  min-height: 0;
  overflow: hidden;
}
@media (max-width: 520px) {
  .orc-map-bar small,
  .map-back span {
    display: none;
  }
  .orc-map-bar a,
  .orc-map-bar button {
    padding: 0 8px;
  }
}
</style>
