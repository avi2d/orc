import { type Element, View, div } from "gpui-kit"
import { h_flex } from "gpui-base"
import { layout, run } from "herdr"
import { palette } from "../../src/palette"
import { activeChild, views, viewsStack } from "../../src/views"

export default class OrcTabs extends View {
  render(): Element {
    const t = palette()
    const active = activeChild(layout(), viewsStack) ?? views[0].id
    return h_flex().id("root").w_full().h(40).px(10).gap(4).items_center().bg(t.chrome).text_size(13)
      .children(views.map((view) => {
        const shown = view.id === active
        return h_flex().id(`tab-${view.id}`).h(28).px(12).gap(8).items_center().rounded(6)
          .bg(shown ? t.raised : t.chrome).text_color(shown ? t.foreground : t.muted)
          .hover((style) => style.bg(t.hover))
          .on_click(() => run("layout.select", { stack: viewsStack, child: view.id }))
          .child(view.label)
          .child(div().text_color(t.dim).child(view.key))
      }))
  }
}
