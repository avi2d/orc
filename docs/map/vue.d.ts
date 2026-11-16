declare module "*.svg?raw" {
  const markup: string
  export default markup
}
declare module "*.vue" {
  import type { DefineComponent } from "vue"
  const component: DefineComponent
  export default component
}
