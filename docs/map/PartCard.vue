<script setup lang="ts">
import { withBase } from "vitepress"
import attention from "../marks/attention.svg?raw"
import done from "../marks/done.svg?raw"
import failed from "../marks/failed.svg?raw"
import running from "../marks/running.svg?raw"
import waiting from "../marks/waiting.svg?raw"
import type { Mark, MapPart } from "./orc-map"

const marks = { attention, done, failed, running, waiting } satisfies Record<Mark, string>

defineProps<{ part: MapPart; folds: boolean; open: boolean }>()
defineEmits<{ toggle: [] }>()
</script>

<template>
  <div class="part" :class="['tone-' + (part.tone ?? 'plain'), { 'is-open': open, 'is-group': part.inside === undefined }]">
    <button v-if="folds" type="button" class="part-fold nodrag nopan" :aria-expanded="open" @click.stop="$emit('toggle')">
      <span class="part-chevron" aria-hidden="true" />
      <span class="part-title" :class="{ mono: part.mono }">{{ part.title }}</span>
      <span v-if="part.mark" class="part-mark" :class="'mark-' + part.mark" aria-hidden="true" v-html="marks[part.mark]" />
    </button>
    <p v-else class="part-title" :class="{ mono: part.mono }">
      {{ part.title }}<span v-if="part.mark" class="part-mark" :class="'mark-' + part.mark" aria-hidden="true" v-html="marks[part.mark]" />
    </p>
    <a v-if="open && part.page" class="part-page nodrag nopan" :href="withBase('/' + part.page)">Read the page<span class="sr"> about {{ part.title }}</span></a>
    <template v-if="!open">
      <p v-if="part.text" class="part-text">{{ part.text }}</p>
      <ul v-if="part.points" class="part-points">
        <li v-for="point in part.points" :key="point">{{ point }}</li>
      </ul>
    </template>
  </div>
</template>

<style>
.part {
  position: relative;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  padding: 10px 12px;
  border: 1px solid var(--m-line);
  border-radius: 10px;
  background: var(--m-card);
  color: var(--m-mute);
  font-size: 12.5px;
  line-height: 1.4;
  text-align: left;
}
.part.tone-work { border-color: var(--m-work); background: var(--m-work-soft); }
.part.tone-ask { border-color: var(--m-ask); background: var(--m-ask-soft); }
.part.tone-ok { border-color: var(--m-ok); background: var(--m-ok-soft); }
.part.is-open,
.part.is-group {
  background: color-mix(in srgb, var(--m-zone) 70%, transparent);
  border-style: dashed;
}
.part.is-group { border-style: solid; }
.part p,
.part ul {
  margin: 0;
}
.part-title {
  color: var(--m-ink);
  font-size: 14px;
  font-weight: 650;
  line-height: 1.3;
}
.part-mark {
  flex: none;
  align-self: center;
  display: inline-block;
  width: 14px;
  height: 14px;
  margin-left: 6px;
  vertical-align: -2px;
}
.part-fold > .part-mark {
  margin-left: 0;
}
.part-mark svg {
  display: block;
  width: 100%;
  height: 100%;
}
.part-mark.mark-running,
.part-mark.mark-failed { color: var(--m-work); }
.part-mark.mark-waiting { color: var(--m-mute); }
.part-mark.mark-done { color: var(--m-ok); }
.part-mark.mark-attention { color: var(--m-ask); }
.part-title.mono {
  font-family: "JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
}
.part-fold {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
/* The whole folded card is the press target, and an open one keeps only its header so the parts inside stay reachable. */
.part:not(.is-open) > .part-fold::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 10px;
}
.part.is-open > .part-fold {
  min-height: 28px;
}
.part-fold:focus-visible {
  outline: none;
}
.part:has(> .part-fold:focus-visible),
.part-page:focus-visible {
  outline: 2px solid var(--m-work);
  outline-offset: 2px;
}
.part-chevron {
  flex: none;
  width: 7px;
  height: 7px;
  border-right: 2px solid var(--m-ink);
  border-bottom: 2px solid var(--m-ink);
  transform: translateY(-2px) rotate(-45deg);
  transition: transform 0.2s ease;
}
.part.is-open > .part-fold .part-chevron {
  transform: translateY(-3px) rotate(45deg);
}
.part-text {
  margin-top: 4px;
}
.part-points {
  margin-top: 4px;
  padding-left: 16px;
  list-style: disc;
}
.part-page {
  position: absolute;
  top: 10px;
  right: 12px;
  color: var(--m-work);
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
@media (prefers-reduced-motion: reduce) {
  .part-chevron { transition: none; }
}
</style>
