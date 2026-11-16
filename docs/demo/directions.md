---
kind: explanation
aside: false
pageClass: wide-page
editLink: false
lastUpdated: false
---
<script setup>
import { ref } from "vue"

const picked = ref("route")
const directions = [
  { id: "route", name: "A. The route" },
  { id: "map", name: "B. The map" },
  { id: "story", name: "C. The storyboard" }
]
</script>

# How orc works

Orc takes work you describe, runs an AI agent on it on one of your machines, and hands you a pull request.

<div class="demo-variants" data-demo-variant>

<div class="demo-switch">
  <button v-for="direction in directions" :key="direction.id" type="button" :aria-pressed="picked === direction.id" @click="picked = direction.id">{{ direction.name }}</button>
</div>

<div v-show="picked === 'route'">

![How orc works, as a route](../diagrams/how-orc-works-route.svg)

</div>
<div v-show="picked === 'map'">

![How orc works, as a map](../diagrams/how-orc-works-map.svg)

</div>
<div v-show="picked === 'story'">

![How orc works, as a storyboard](../diagrams/how-orc-works-story.svg)

</div>

</div>

## What each direction is

- **A. The route** follows one task left to right through seven numbered stops, with the questions a run asks drawn as a loop below.
- **B. The map** shows where each part lives, on you, on the machine that plans, on a machine that works and on GitHub, with numbered arrows for the order.
- **C. The storyboard** tells the same path as six small scenes, with fewer parts named.
