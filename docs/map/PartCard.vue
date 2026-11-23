<script setup lang="ts">
import { onBeforeUnmount, ref, useId, watch } from "vue"
import { withBase } from "vitepress"
import { detailsAfter, returnsFocus, type DetailsEvent, type DetailsState } from "./details"
import type { MapPart } from "./orc-map"

defineProps<{ part: MapPart; folds: boolean; open: boolean; depth?: number }>()
defineEmits<{ toggle: [] }>()

const details = ref<DetailsState>("closed")
const button = ref<HTMLButtonElement>()
const panel = ref<HTMLElement>()
const panelId = useId()
let leaving: ReturnType<typeof setTimeout> | undefined
let following = 0

const send = (event: DetailsEvent): boolean => {
  clearTimeout(leaving)
  const before = details.value
  details.value = detailsAfter(before, event)
  return returnsFocus(before, event)
}

const refocus = (): void => button.value?.focus({ preventScroll: true })

const focusLost = (): boolean => document.activeElement === null || document.activeElement === document.body

const focusInside = (): boolean => {
  const at = document.activeElement
  return at !== null && (button.value?.contains(at) === true || panel.value?.contains(at) === true)
}

// A press moves focus after its pointerdown, at mousedown for a mouse and at the later mousedown of a tap, so focus returns once the press ends.
const refocusAfter = (press: PointerEvent): void => {
  const ends = press.pointerType === "touch" ? ["click", "pointercancel"] : ["pointerup", "pointercancel"]
  const done = (): void => {
    for (const name of ends) document.removeEventListener(name, done, true)
    if (focusLost()) refocus()
  }
  for (const name of ends) document.addEventListener(name, done, true)
}

const enter = (event: PointerEvent): void => {
  if (event.pointerType === "mouse") send("enter")
}

// The pointer crosses a gap between the button and the details, so a leave waits for an enter on the other one.
const leave = (event: PointerEvent): void => {
  if (event.pointerType !== "mouse") return
  clearTimeout(leaving)
  leaving = setTimeout(() => send("leave"), 150)
}

const pressAnywhere = (event: PointerEvent): void => {
  const target = event.target
  if (target instanceof Node && (button.value?.contains(target) || panel.value?.contains(target))) return
  if (send("outside")) refocusAfter(event)
}

const keyAnywhere = (event: KeyboardEvent): void => {
  if (event.key === "Escape" && send("escape") && (focusInside() || focusLost())) refocus()
}

const place = (): void => {
  const at = button.value?.getBoundingClientRect()
  const box = panel.value
  if (at === undefined || box === undefined) return
  const width = Math.min(280, window.innerWidth - 16)
  box.style.width = width.toString() + "px"
  box.style.left = Math.max(8, Math.min(at.right - width, window.innerWidth - width - 8)).toString() + "px"
  const below = at.bottom + 6
  const above = at.top - 6 - box.offsetHeight
  box.style.top = Math.max(8, below + box.offsetHeight > window.innerHeight - 8 && above >= 8 ? above : below).toString() + "px"
}

// The map moves its nodes by transform on zoom, pan and refit, which no resize or scroll event reports, so the details follow the button each frame.
const follow = (): void => {
  place()
  following = requestAnimationFrame(follow)
}

const listen = (on: boolean): void => {
  const method = on ? "addEventListener" : "removeEventListener"
  document[method]("pointerdown", pressAnywhere, true)
  document[method]("keydown", keyAnywhere)
}

watch(details, (now, before) => {
  const shown = now !== "closed"
  if (shown === (before !== "closed")) return
  if (shown) {
    panel.value?.showPopover()
    follow()
  } else {
    cancelAnimationFrame(following)
    panel.value?.hidePopover()
  }
  listen(shown)
})

onBeforeUnmount(() => {
  clearTimeout(leaving)
  cancelAnimationFrame(following)
  listen(false)
})
</script>

<template>
  <div class="part" :class="['tone-' + (part.tone ?? 'plain'), { 'is-open': open, 'is-group': part.inside === undefined }]" :data-depth="depth ?? 0">
    <button v-if="folds" type="button" class="part-fold nodrag nopan" :aria-expanded="open" @click.stop="$emit('toggle')">
      <span class="part-chevron" aria-hidden="true" />
      <span class="part-title" :class="{ mono: part.mono }">{{ part.title }}</span>
    </button>
    <p v-else class="part-title" :class="{ mono: part.mono }">{{ part.title }}</p>
    <button
      ref="button"
      type="button"
      class="part-info nodrag nopan"
      :aria-expanded="details !== 'closed'"
      :aria-controls="panelId"
      @click.stop="send('press')"
      @pointerenter="enter"
      @pointerleave="leave"
    >
      <span aria-hidden="true">i</span><span class="sr">Details about {{ part.title }}</span>
    </button>
    <div :id="panelId" ref="panel" popover="manual" class="part-details nodrag nopan nowheel" role="region" :aria-label="part.title" @pointerenter="enter" @pointerleave="leave">
      <p class="part-title" :class="{ mono: part.mono }">{{ part.title }}</p>
      <p v-if="!part.details" class="part-text">{{ part.short }}</p>
      <p v-if="part.details?.text" class="part-text">{{ part.details.text }}</p>
      <ul v-if="part.details?.points" class="part-points">
        <li v-for="point in part.details.points" :key="point">{{ point }}</li>
      </ul>
    </div>
    <a v-if="open && part.page" class="part-page nodrag nopan" :href="withBase('/' + part.page)">Read the page<span class="sr"> about {{ part.title }}</span></a>
    <p v-if="!open" class="part-text">{{ part.short }}</p>
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
.part.tone-ask { border-color: var(--m-ask); background: var(--m-ask-soft); }
.part.tone-ok { border-color: var(--m-ok); background: var(--m-ok-soft); }
.part.tone-end { border-color: var(--m-mute); background: var(--m-end-soft); }
.part.tone-ask,
.part.tone-ok {
  color: var(--m-ink);
}
.part.is-open,
.part.is-group {
  background: var(--m-zone);
  border-color: var(--m-area-edge);
}
.part.is-open[data-depth="1"] { background: color-mix(in srgb, var(--m-zone) 84%, var(--m-line)); }
.part.is-open[data-depth="2"] { background: color-mix(in srgb, var(--m-zone) 68%, var(--m-line)); }
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
.part > .part-title,
.part > .part-fold {
  box-sizing: border-box;
  padding-right: 26px;
}
.part-title.mono {
  font-family: var(--vp-font-family-mono);
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
  outline: 2px solid var(--m-ink);
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
.part-info {
  position: absolute;
  z-index: 1;
  top: 7px;
  right: 7px;
  width: 24px;
  height: 24px;
  margin: 0;
  padding: 0;
  border: 1px solid var(--m-line);
  border-radius: 50%;
  background: var(--m-card);
  color: var(--m-ink);
  font: italic 650 13px/1 var(--vp-font-family-base);
  cursor: pointer;
}
.part-info:focus-visible {
  outline: 2px solid var(--m-ink);
  outline-offset: 2px;
}
.part-details {
  inset: auto;
  box-sizing: border-box;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--m-line);
  border-radius: 10px;
  background: var(--m-card);
  box-shadow: 0 6px 24px rgb(0 0 0 / 0.18);
  color: var(--m-mute);
  font-size: 12.5px;
  line-height: 1.4;
  text-align: left;
}
.part-details p,
.part-details ul {
  margin: 0;
}
.part-page {
  position: absolute;
  top: 10px;
  right: 40px;
  color: var(--m-ink);
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
