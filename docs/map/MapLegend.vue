<script setup lang="ts">
import { arrowMeanings, blockMeanings } from "./orc-map"
</script>

<template>
  <ul class="map-key">
    <li v-for="(meaning, look) in blockMeanings" :key="look"><span class="key-block" :class="'key-' + look" aria-hidden="true" />{{ meaning }}</li>
    <li v-for="(meaning, tone) in arrowMeanings" :key="tone">
      <svg class="key-arrow" :class="'key-' + tone" viewBox="0 0 34 12" aria-hidden="true"><path class="key-shaft" d="M1 6H25" /><path class="key-head" d="M33 6L24 1.5V10.5Z" /></svg>{{ meaning }}
    </li>
  </ul>
</template>

<style>
.map-key {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 22px;
  margin: 0;
  padding: 0;
  list-style: none;
  color: var(--paint-ink);
  font-size: 12.5px;
  line-height: 1.3;
}
.vp-doc ul.map-key {
  margin: 18px 0 8px;
  padding: 0;
}
.map-key li {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 0;
}
.vp-doc ul.map-key > li::before {
  content: none;
}
.key-block {
  flex: none;
  box-sizing: border-box;
  width: 26px;
  height: 16px;
  border: 1.5px solid var(--paint-line);
  border-radius: 4px;
  background: var(--paint-surface);
}
.key-block.key-plain { border-color: var(--paint-edge); }
.key-block.key-ask { border-color: var(--paint-ask); background: var(--paint-ask-soft); }
.key-block.key-ok { border-color: var(--paint-ok); background: var(--paint-ok-soft); }
.key-block.key-end { border-color: var(--paint-muted); background: var(--paint-end-soft); }
.key-block.key-area {
  width: 30px;
  height: 22px;
  border-color: var(--paint-area-edge);
  border-radius: 6px;
  background: var(--paint-surface-2);
}
.orc-map .key-block.key-plain { border: 1px solid var(--m-line); }
.home-page .key-block.key-area { border-color: var(--paint-edge); }
.key-arrow {
  flex: none;
  width: 34px;
  height: 12px;
}
.key-shaft { fill: none; stroke: currentColor; stroke-width: 2; }
.key-head { fill: currentColor; }
.key-arrow.key-work { color: var(--paint-work); }
.key-arrow.key-aside { color: var(--paint-muted); }
.key-arrow.key-ask { color: var(--paint-ask); }
.key-arrow.key-ask .key-shaft { stroke-dasharray: 5 4; }
</style>
