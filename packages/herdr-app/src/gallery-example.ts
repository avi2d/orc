import { type Context, type Element, div } from "gpui-kit"
import { Button, InputState, h_flex, v_flex } from "gpui-base"
import { visibleGalleryRows } from "./gallery-selection"
import type { GalleryStory } from "./gallery-stories"
import { alert, button, card, checkIcon, field, fieldWithButton, kbd, radio, selectTrigger, statusDot, tab, vendorLogo } from "./kit"
import { linkedText } from "./links-view"
import type { Palette } from "./palette-values"
import { uniformRows } from "./rows-list"
import { type ThreadControls, readOnlyThread, threadDecided, threadEntry } from "./thread-view"

const projects = ["All projects", "Garden", "Orc"] as const

export class GalleryExample {
  input = InputState.new({ placeholder: "Write a sample answer" })
  receipt: string | null = null
  selectedTab: boolean | null = null
  checkedRadio: boolean | null = null
  selectedProject: string | null = null
  selectOpen = false
  folded = new Set<string>()
  selectedRun: string | null = null

  reset(story: GalleryStory, cx: Context): void {
    this.receipt = null
    this.selectedTab = null
    this.checkedRadio = null
    this.selectedProject = null
    this.selectOpen = false
    this.folded.clear()
    this.selectedRun = null
    this.input.set_value(story.component === "field" || story.component === "fieldWithButton" ? story.value : "")
    cx.notify()
  }

  record(message: string, cx: Context): void {
    this.receipt = message
    cx.notify()
  }

  send(cx: Context): void {
    const answer = this.input.value().trim()
    this.record(answer === "" ? "No sample answer to send." : `Sample answer: ${answer}`, cx)
  }

  dismissSelect(cx: Context): boolean {
    if (!this.selectOpen) return false
    this.selectOpen = false
    cx.notify()
    return true
  }

  private select(t: Palette, story: Extract<GalleryStory, { component: "selectTrigger" }>): Element {
    const choose = (value: string, cx: Context): void => {
      this.selectedProject = value
      this.selectOpen = false
      this.record(`Sample project: ${value}`, cx)
    }
    const trigger = selectTrigger(t, story.id, this.selectedProject ?? story.value, story.size, 176, (cx) => {
      this.selectOpen = !this.selectOpen
      cx.notify()
    })
    return v_flex().id("gallery-select-example").gap(4).items_start()
      .on_mouse_down_out((_event, cx) => { this.dismissSelect(cx) })
      .child(trigger)
      .children(this.selectOpen ? [v_flex().p(4).gap(2).bg(t.raised).rounded(8)
        .children(projects.map((project, index) => Button.new(`project-${index}`).child(project)
          .on_click((_event, cx) => choose(project, cx))))] : [])
  }

  private rows(t: Palette, story: Extract<GalleryStory, { component: "uniformRows" }>): Element {
    const rows = visibleGalleryRows(story, this.folded)
    return v_flex().h(198).w_full().border(1).border_color(t.border).rounded(8)
      .children(rows.length === 0 ? [div().p(8).text_color(t.muted).child("No runs in this example.")] : [])
      .child(uniformRows(story.id, rows, (row) => row.key, (row) => {
        const line = h_flex().h(26).px(8).items_center().gap(6).rounded(4)
          .bg(this.selectedRun === row.key ? t.selected : t.surface)
          .hover((style) => style.bg(t.hover))
        return row.kind === "group"
          ? line.font_semibold().child(this.folded.has(row.key) ? "▸" : "▾").child(row.label)
          : line.child(statusDot(row.status)).child(div().min_w_0().truncate().child(row.label))
      }, { x: 6, y: 6 }, (row, cx) => {
        if (row.kind === "group") {
          if (this.folded.has(row.key)) this.folded.delete(row.key)
          else this.folded.add(row.key)
          cx.notify()
        } else {
          this.selectedRun = row.key
          this.record(`Sample run: ${row.label}`, cx)
        }
      }))
  }

  private thread(t: Palette, story: Extract<GalleryStory, { component: "threadEntry" }>): Element {
    if (story.reply.kind === "read-only") return threadEntry(t, story.card, readOnlyThread)
    const reply = story.reply
    const controls: ThreadControls = {
      option: (_card, option, shown) => shown.cursor_pointer().on_click((_event, cx) => this.record(`Sample option: ${option.text}`, cx)),
      reply: () => [fieldWithButton(this.input, button(t, "gallery-thread-send", "Send", "primary", 32, (cx) => this.send(cx)))],
      failure: () => reply.kind === "failed" ? [div().text_color(t.blocked).whitespace_normal().child(reply.reason)] : []
    }
    return threadEntry(t, story.card, controls)
  }

  render(t: Palette, story: GalleryStory): Element {
    switch (story.component) {
      case "button": return button(t, story.id, "Run example", story.look, story.size,
        story.disabled ? null : (cx) => this.record("Example button pressed.", cx))
      case "field": return field(this.input, story.size)
      case "fieldWithButton": return fieldWithButton(this.input, button(t, story.id, story.action === "sending" ? "Sending" : "Send",
        "primary", 32, story.action === "sending" ? null : (cx) => this.send(cx)))
      case "selectTrigger": return this.select(t, story)
      case "card": return card().p(12).gap(8).child(div().whitespace_normal().child(story.body))
        .child(h_flex().gap(6).items_center().child(radio(true)).child("In Herdr"))
      case "tab": return tab(t, story.id, story.label, this.selectedTab ?? story.active, story.disabled ? null : (cx) => {
        this.selectedTab = true
        this.record("Example tab selected.", cx)
      })
      case "kbd": return kbd(t, story.key)
      case "radio": {
        const checked = this.checkedRadio ?? story.checked
        return Button.new(story.id).pressed(checked).child(h_flex().gap(6).items_center()
          .child(radio(checked)).child(checked ? "Checked" : "Unchecked"))
          .on_click((_event, cx) => {
            this.checkedRadio = !checked
            this.record(checked ? "Sample choice cleared." : "Sample choice checked.", cx)
          })
      }
      case "statusDot": return h_flex().gap(6).items_center().child(statusDot(story.status)).child(story.status)
      case "checkIcon": return h_flex().gap(6).items_center().child(checkIcon(story.state)).child(story.label)
      case "vendorLogo": return h_flex().gap(6).items_center().child(vendorLogo(story.vendor)).child(story.label)
      case "alert": return alert(t, story.id, { ...story.shown, actions: (story.shown.actions ?? []).map((label, index) => ({
        id: `${story.id}-action-${index}`,
        label,
        press: (cx) => this.record(`Sample action: ${label}`, cx)
      })) })
      case "uniformRows": return this.rows(t, story)
      case "linkedText": return linkedText(story.id, story.text, (url, cx) => this.record(`Sample link: ${url}`, cx))
      case "threadEntry": return this.thread(t, story)
      case "threadDecided": return v_flex().gap(8).children(threadDecided(t, story.thread))
    }
  }
}
