import { type AsyncContext, type Color, type Context, type Element, type FocusHandle, View, div } from "gpui-kit"
import { Button, Input, InputState, h_flex, v_flex } from "gpui-base"
import { closeOverlay, props, themes } from "herdr"
import { monospace } from "../../src/fonts"
import { GalleryExample } from "../../src/gallery-example"
import { findGalleryStories } from "../../src/gallery-selection"
import { type GalleryStory, galleryControlHeights, galleryStories } from "../../src/gallery-stories"
import { fields } from "../../src/guard"
import { button } from "../../src/kit"
import { alertColors, dotColour, tw, zinc } from "../../src/kit-colors"
import { type Palette, resolvePalette } from "../../src/palette-values"
import { palette } from "../../src/palette"

const pages = ["Examples", "Colours", "Type and spacing"] as const
type Page = typeof pages[number]

const presets = ["graphite", "paper"] as const
type Preset = typeof presets[number]
type Preview = "active" | Preset

const previewLabels = { active: "Active theme", graphite: "Graphite", paper: "Paper" } as const satisfies Record<Preview, string>

const heading = (words: string): Element => div().font_semibold().text_size(15).whitespace_normal().child(words)

const muted = (t: Palette, words: string): Element => div().text_size(12).text_color(t.muted).whitespace_normal().child(words)

const choice = (id: string, label: string, pressed: boolean, act: (cx: Context) => void): Element =>
  Button.new(id).pressed(pressed).child(label).on_click((_event, cx) => act(cx))

const swatchSet = (t: Palette, label: string, values: ReadonlyArray<readonly [string, Color]>): Element =>
  v_flex().gap(8).child(heading(label)).child(h_flex().flex_wrap().gap(8).children(values.map(([name, value]) =>
    v_flex().w(134).gap(4).p(8).rounded(8).border(1).border_color(t.border)
      .child(div().h(28).rounded(4).bg(value).border(1).border_color(t.border))
      .child(div().text_size(12).whitespace_normal().child(name))
      .child(div().text_size(12).font_family(monospace()).text_color(t.muted).child(value)))))

const colours = (t: Palette): Element =>
  v_flex().gap(16)
    .child(muted(t, "Translucent swatches are drawn over the example surface."))
    .child(swatchSet(t, "Herdr theme roles", Object.entries(t)))
    .child(swatchSet(t, "Orc zinc colours", Object.entries(zinc)))
    .child(swatchSet(t, "Run status dots", Object.entries(dotColour)))
    .child(swatchSet(t, "Fixed icon colours", Object.entries(tw)))
    .child(swatchSet(t, "Alert fills and marks", Object.entries(alertColors).flatMap(([tone, ink]) => [
      [`${tone} fill`, ink.bg] as const, [`${tone} mark`, ink.colour] as const
    ])))

const typeAndSpacing = (t: Palette, fixture: GalleryExample): Element =>
  v_flex().gap(12)
    .child(heading("Typography"))
    .child(div().text_size(13).child("13 px · Body and standard controls · Active UI font"))
    .child(div().text_size(12).child("12 px · Metadata and compact controls · Active UI font"))
    .child(div().text_size(12).font_family(monospace()).child(`12 px · Tool output · ${monospace()}`))
    .child(heading("Control heights"))
    .child(muted(t, "The kit has no shared spacing scale. These examples use its two control heights."))
    .children(galleryControlHeights.map((height) => h_flex().gap(8).items_center()
      .child(button(t, `control-height-${height}`, `${height} px`, "primary", height,
        (cx) => fixture.record(`${height} px example button pressed.`, cx)))))
    .children(fixture.receipt === null ? [] : [muted(t, fixture.receipt)])

export default class OrcDesignSystem extends View {
  private page: Page = "Examples"
  private preview: Preview = "active"
  private narrow = false
  private story: GalleryStory = galleryStories[0]
  private search = InputState.new({ placeholder: "Find an example" })
  private fixture = new GalleryExample()
  private presetColours = new Map<Preset, Palette>()
  private overlay: string | null = null
  private focusHandle: FocusHandle | null = null

  override init(_props: unknown, cx: AsyncContext): void {
    this.focusHandle = cx.focus_handle()
    this.focusHandle.focus()
    const received = fields(props(), "")
    if (received.kind !== "refused" && typeof received.value["overlay"] === "string") {
      this.overlay = received.value["overlay"]
    }
    const available = themes()
    for (const name of presets) {
      const preset = available.find((value) => value.name === name)
      if (preset !== undefined) this.presetColours.set(name, resolvePalette(preset.colors))
    }
    this.search.on("change", (_event, changed) => changed.notify())
    this.fixture.input.on("submit", (_event, submitted) => {
      if (this.page === "Examples") this.fixture.submit(this.story, submitted)
    })
    this.fixture.reset(this.story, cx)
  }

  override close(_cx: AsyncContext): void {
    this.search.release()
    this.fixture.input.release()
    this.focusHandle?.release()
  }

  private closeWindow(): void {
    if (this.overlay !== null) closeOverlay(this.overlay)
  }

  private toolbar(t: Palette): Element {
    const previews: ReadonlyArray<Preview> = ["active", ...this.presetColours.keys()]
    return v_flex().gap(8).px(12).pb(10).bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().gap(6).flex_wrap().children(pages.map((page, index) =>
        choice(`gallery-page-${index}`, page, this.page === page, (cx) => { this.page = page; cx.notify() }))))
      .child(h_flex().gap(6).flex_wrap().children(previews.map((preview) =>
        choice(`gallery-theme-${preview}`, previewLabels[preview], this.preview === preview,
          (cx) => { this.preview = preview; cx.notify() }))))
      .children(this.preview === "active" ? [] : [muted(t, "The preview changes Orc colours only. Native inputs still use the active Herdr theme.")])
  }

  private catalog(t: Palette): Element {
    const matches = findGalleryStories(this.search.value())
    return v_flex().w(200).min_w(142).gap(8).p(10).min_h_0().border_r(1).border_color(t.border)
      .child(Input.new(this.search).w_full().accessibility_label("Find an example"))
      .child(v_flex().id("gallery-catalog").flex_1().min_h_0().overflow_y_scrollbar().gap(4)
        .children(matches.length === 0 ? [muted(t, "No examples match your search.")] : matches.map((story) =>
          Button.new(`choose-${story.id}`).pressed(story.id === this.story.id).w_full().min_w_0()
            .accessibility_label(`${story.component}: ${story.label}`)
            .child(div().min_w_0().truncate().child(`${story.component} · ${story.label}`))
            .on_click((_event, cx) => {
              if (this.story.id === story.id) return
              this.story = story
              this.fixture.reset(story, cx)
            }))))
  }

  private example(t: Palette): Element {
    const story = this.story
    const sample = v_flex().id("gallery-specimen").w_full().min_w_0().p(12).gap(8).bg(t.surface)
      .rounded(8).border(1).border_color(t.border).overflow_x_scrollbar()
      .child(this.fixture.render(t, story))
    const tools = h_flex().gap(6).flex_wrap()
      .child(choice("gallery-narrow", "320 px preview", this.narrow, (cx) => { this.narrow = !this.narrow; cx.notify() }))
      .child(Button.new("gallery-reset").child("Reset example").on_click((_event, cx) => this.fixture.reset(story, cx)))
    return v_flex().id("gallery-example").flex_1().min_w_0().min_h_0().overflow_y_scrollbar().p(12).gap(8)
      .child(heading(story.label)).child(muted(t, story.id)).child(tools)
      .child(this.narrow ? sample.max_w(320) : sample)
      .children(this.fixture.receipt === null ? [] : [div().id("gallery-receipt").text_color(t.muted).whitespace_normal().child(this.fixture.receipt)])
  }

  render(): Element {
    const active = palette()
    const t = this.preview === "active" ? active : this.presetColours.get(this.preview) ?? active
    const content = this.page === "Examples"
      ? h_flex().flex_1().min_h_0().min_w_0().child(this.catalog(t)).child(this.example(t))
      : v_flex().id("gallery-reference").flex_1().min_h_0().overflow_y_scrollbar().p(12)
        .child(this.page === "Colours" ? colours(t) : typeAndSpacing(t, this.fixture))
    const root = v_flex().id("orc-design-system").size_full().overflow_hidden().bg(t.surface).text_color(t.foreground).text_size(13)
    if (this.focusHandle !== null) root.track_focus(this.focusHandle)
    return root
      .on_key_down((event, cx) => {
        if (event.key !== "escape") return
        if (!this.fixture.dismissSelect(cx)) this.closeWindow()
        cx.stop_propagation()
      })
      .child(h_flex().gap(8).p(12).items_center().bg(t.chrome)
        .child(v_flex().flex_1().min_w_0().gap(2)
          .child(heading("Orc Design System"))
          .child(muted(t, "Examples use sample data. No Orc task can change here.")))
        .children(this.overlay === null ? [] : [Button.new("gallery-close").child("Close")
          .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
          .on_click(() => this.closeWindow())]))
      .child(v_flex().flex_1().min_h_0().min_w_0().on_mouse_down("left", (_event, cx) => cx.stop_propagation())
        .child(this.toolbar(t)).child(content))
  }
}
