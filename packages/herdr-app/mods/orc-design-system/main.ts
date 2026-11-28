import { type AsyncContext, type Color, type Context, type Element, type FocusHandle, View, div } from "gpui-kit"
import { InputState, h_flex, v_flex } from "gpui-base"
import { run, themes } from "herdr"
import { monospace } from "../../src/fonts"
import { GalleryExample } from "../../src/gallery-example"
import { findGalleryStories } from "../../src/gallery-selection"
import { type GalleryStory, galleryControlHeights, galleryStories } from "../../src/gallery-stories"
import { button, field, tab } from "../../src/kit"
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

const previewWidth = 320

const widths = [
  { id: "gallery-width-full", label: "Full width", narrow: false },
  { id: "gallery-narrow", label: `${previewWidth} px preview`, narrow: true }
] as const

const leaveGallery = (): void => {
  run("layout.switch", { name: "orc" })
}

const catalogEntry = (t: Palette, story: GalleryStory, chosen: boolean, choose: (cx: Context) => void): Element =>
  h_flex().id(`choose-${story.id}`).h(28).flex_none().px(8).gap(6).items_center().rounded(6).cursor_pointer()
    .when(chosen, (row) => row.bg(t.selected))
    .hover((style) => style.bg(chosen ? t.selected : zinc.s2))
    .tooltip(story.id)
    .accessibility_label(`${story.component}: ${story.label}`)
    .on_click((_event, cx) => choose(cx))
    .child(div().flex_none().text_size(12).text_color(t.muted).child(story.component))
    .child(div().flex_1().min_w_0().truncate().text_color(t.foreground).child(story.label))

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

type ControlHeight = typeof galleryControlHeights[number]

const typeAndSpacing = (t: Palette, pressedHeight: ControlHeight | null, press: (height: ControlHeight, cx: Context) => void): Element =>
  v_flex().gap(12)
    .child(heading("Typography"))
    .child(div().text_size(13).child("13 px · Body and standard controls · Active UI font"))
    .child(div().text_size(12).child("12 px · Metadata and compact controls · Active UI font"))
    .child(div().text_size(12).font_family(monospace()).child(`12 px · Tool output · ${monospace()}`))
    .child(heading("Control heights"))
    .child(muted(t, "The kit has no shared spacing scale. These examples use its two control heights."))
    .children(galleryControlHeights.map((height) => h_flex().gap(8).items_center()
      .child(button(t, `control-height-${height}`, `${height} px`, "primary", height,
        (cx) => press(height, cx)))))
    .children(pressedHeight === null ? [] : [muted(t, `${pressedHeight} px example button pressed.`)])

export default class OrcDesignSystem extends View {
  private page: Page = "Examples"
  private preview: Preview = "active"
  private narrow = false
  private pressedHeight: ControlHeight | null = null
  private story: GalleryStory = galleryStories[0]
  private readonly search = InputState.new({ placeholder: "Find an example" })
  private readonly fixture = new GalleryExample()
  private readonly presetColours = new Map<Preset, Palette>()
  private focusHandle: FocusHandle | null = null

  override init(_props: unknown, cx: AsyncContext): void {
    this.focusHandle = cx.focus_handle()
    this.focusHandle.focus()
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

  private toolbar(t: Palette): Element {
    const previews: ReadonlyArray<Preview> = ["active", ...this.presetColours.keys()]
    return v_flex().flex_none().gap(8).px(12).py(8).bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().gap(16).flex_wrap()
        .child(h_flex().gap(4).children(pages.map((page, index) =>
          tab(t, `gallery-page-${index}`, page, this.page === page, (cx) => { this.page = page; cx.notify() }))))
        .child(h_flex().gap(4).children(previews.map((preview) =>
          tab(t, `gallery-theme-${preview}`, previewLabels[preview], this.preview === preview,
            (cx) => { this.preview = preview; cx.notify() })))))
      .children(this.preview === "active" ? [] : [muted(t, "The preview changes Orc colours only. Native inputs still use the active Herdr theme.")])
  }

  private catalog(t: Palette): Element {
    const matches = findGalleryStories(this.search.value())
    return v_flex().id("gallery-sidebar").w(240).flex_none().h_full().min_h_0().gap(8).p(10).bg(t.chrome).border_r(1).border_color(t.border)
      .child(h_flex().h(32).flex_none().child(field(this.search, 32)))
      .child(v_flex().id("gallery-catalog").flex_1().min_h_0().overflow_y_scrollbar().gap(2)
        .children(matches.length === 0 ? [muted(t, "No examples match your search.")] : matches.map((story) =>
          catalogEntry(t, story, story.id === this.story.id, (cx) => {
            if (this.story.id === story.id) return
            this.story = story
            this.fixture.reset(story, cx)
          }))))
  }

  private example(t: Palette): Element {
    const story = this.story
    const frame = v_flex().id("gallery-specimen").items_start().p(12).gap(8).bg(t.surface)
      .rounded(8).border(1).border_color(t.border).overflow_x_scrollbar()
      .child(this.fixture.render(t, story))
    const tools = h_flex().gap(16).flex_wrap()
      .child(h_flex().gap(4).children(widths.map((width) =>
        tab(t, width.id, width.label, this.narrow === width.narrow, (cx) => { this.narrow = width.narrow; cx.notify() }))))
      .child(button(t, "gallery-reset", "Reset example", "secondary", 24, (cx) => this.fixture.reset(story, cx)))
    return v_flex().id("gallery-example").flex_1().min_w_0().h_full().min_h_0().overflow_y_scrollbar().p(12).gap(8)
      .child(heading(story.label)).child(muted(t, story.id)).child(tools)
      .child(this.narrow ? frame.w(previewWidth).max_w_full() : frame.w_full())
      .children(this.fixture.receipt === null ? [] : [div().id("gallery-receipt").text_color(t.muted).whitespace_normal().child(this.fixture.receipt)])
  }

  render(): Element {
    const active = palette()
    const t = this.preview === "active" ? active : this.presetColours.get(this.preview) ?? active
    const content = this.page === "Examples"
      ? h_flex().flex_1().min_h_0().min_w_0().items_start().child(this.catalog(t)).child(this.example(t))
      : v_flex().id("gallery-reference").flex_1().min_h_0().overflow_y_scrollbar().p(12)
        .child(this.page === "Colours" ? colours(t) : typeAndSpacing(t, this.pressedHeight, (height, cx) => {
          this.pressedHeight = height
          cx.notify()
        }))
    const root = v_flex().id("orc-design-system").size_full().overflow_hidden().bg(t.surface).text_color(t.foreground).text_size(13)
    const focused = this.focusHandle === null ? root : root.track_focus(this.focusHandle)
    return focused
      .on_key_down((event, cx) => {
        if (event.key !== "escape") return
        if (!this.fixture.dismissSelect(cx)) leaveGallery()
        cx.stop_propagation()
      })
      .child(h_flex().flex_none().gap(8).px(12).py(10).items_center().bg(t.chrome)
        .child(v_flex().flex_1().min_w_0().gap(2)
          .child(heading("Orc Design System"))
          .child(muted(t, "Examples use sample data. No Orc task can change here.")))
        .child(button(t, "gallery-back", "Back to Orc", "secondary", 24, leaveGallery)))
      .child(this.toolbar(t))
      .child(content)
  }
}
