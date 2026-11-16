import { defineClientComponent } from "vitepress"

export const MapFlow = defineClientComponent(() => import("./MapFlow.vue"))
export const MapCyto = defineClientComponent(() => import("./MapCyto.vue"))
export const MapMind = defineClientComponent(() => import("./MapMind.vue"))
