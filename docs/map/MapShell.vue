<script setup lang="ts">
import { useData, withBase } from "vitepress"
import { mapTitle } from "./orc-map"

defineProps<{ draft: string }>()
defineEmits<{ openAll: []; foldAll: [] }>()

const { isDark } = useData()
</script>

<template>
  <div class="orc-map">
    <header class="map-bar">
      <a class="map-back" :href="withBase('/')" aria-label="Back to the orc docs">←<span> Docs</span></a>
      <h1>{{ mapTitle }}<small>{{ draft }}</small></h1>
      <button type="button" @click="$emit('openAll')">Open all</button>
      <button type="button" @click="$emit('foldAll')">Fold all</button>
      <button type="button" :aria-pressed="isDark" @click="isDark = !isDark">{{ isDark ? "Light" : "Dark" }}</button>
    </header>
    <main class="map-stage"><slot /></main>
  </div>
</template>

<style>
.orc-map {
  --m-ink: light-dark(#1f2328, #e8eaed);
  --m-mute: light-dark(#57606a, #a3abb5);
  --m-line: light-dark(#c8cdd5, #474d57);
  --m-card: light-dark(#ffffff, #22252b);
  --m-zone: light-dark(#f3f4f6, #17191d);
  --m-page: light-dark(#fbfbfc, #101114);
  --m-work: light-dark(#3451b2, #a8b1ff);
  --m-work-soft: light-dark(#e8ebfc, #272c52);
  --m-ask: light-dark(#8a5a00, #e9b949);
  --m-ask-soft: light-dark(#fff3d1, #3a300f);
  --m-ok: light-dark(#17794c, #48d597);
  --m-ok-soft: light-dark(#def5e8, #12301f);
  position: fixed;
  inset: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  background: var(--m-page);
  color: var(--m-ink);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.map-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  padding-top: max(8px, env(safe-area-inset-top));
  border-bottom: 1px solid var(--m-line);
  background: var(--m-card);
}
.map-bar h1 {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 15px;
  font-weight: 650;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.map-bar small {
  margin-left: 8px;
  color: var(--m-mute);
  font-size: 12px;
  font-weight: 500;
}
.map-bar a,
.map-bar button {
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
.map-bar a:focus-visible,
.map-bar button:focus-visible {
  outline: 2px solid var(--m-work);
  outline-offset: 2px;
}
.map-stage {
  position: relative;
  min-height: 0;
  overflow: hidden;
}
@media (max-width: 520px) {
  .map-bar small,
  .map-back span {
    display: none;
  }
  .map-bar a,
  .map-bar button {
    padding: 0 8px;
  }
}
</style>
