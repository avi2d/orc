import { type Context, type Element, div } from "gpui-kit"
import { Button, InputState, h_flex, v_flex } from "gpui-base"
import { visibleGalleryRows } from "./gallery-selection"
import type { GalleryStory } from "./gallery-stories"
import { type MenuChoice, alert, button, card, checkIcon, field, fieldWithButton, groupRow, kbd, menuPanel, radio, runRow, selectTrigger, statusDot, tab, vendorLogo } from "./kit"
import { linkedText } from "./links-view"
import type { Palette } from "./palette-values"
import { uniformRows } from "./rows-list"
import { runsHeader } from "./run-menus"
import { type ThreadControls, readOnlyThread, threadDecided, threadEntry } from "./thread-view"

const projects: ReadonlyArray<MenuChoice> = [
  { name: "All", count: 12 },
  { name: "garden", count: 5 },
  { name: "orchard-runner-with-a-long-project-name", count: 7 },
  { name: "All runs", count: 20 }
]

const threadWidth = 460

const specimenWidths = {
  button: null, field: 320, fieldWithButton: threadWidth, selectTrigger: null, card: threadWidth, tab: null, kbd: null, radio: null,
  statusDot: null, checkIcon: null, vendorLogo: null, alert: threadWidth, uniformRows: runsHeader.width, linkedText: threadWidth,
  threadEntry: threadWidth, threadDecided: threadWidth
} as const satisfies Record<GalleryStory["component"], number | null>

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

  private sendAction(story: GalleryStory): ((cx: Context) => void) | null {
    if (!((story.component === "fieldWithButton" && story.action === "send")
      || (story.component === "threadEntry" && story.reply.kind !== "read-only"))) return null
    return (cx) => {
      const answer = this.input.value().trim()
      this.record(answer === "" ? "No sample answer to send." : `Sample answer: ${answer}`, cx)
    }
  }

  submit(story: GalleryStory, cx: Context): void {
    this.sendAction(story)?.(cx)
  }

  dismissSelect(cx: Context): boolean {
    if (!this.selectOpen) return false
    this.selectOpen = false
    cx.notify()
    return true
  }

  private select(t: Palette, story: Extract<GalleryStory, { component: "selectTrigger" }>): Element {
    const label = this.selectedProject ?? story.value
    const open = this.selectOpen
    const trigger = selectTrigger(t, story.id, label, story.size, 176, (cx) => {
      this.selectOpen = !open
      cx.notify()
    })
    const menu = menuPanel(t, "gallery-project", projects, (choice) => choice.name === label, (choice, cx) => {
      this.selectedProject = choice.name
      this.selectOpen = false
      this.record(`Sample project: ${choice.name}`, cx)
    }, (cx) => { this.dismissSelect(cx) })
    return v_flex().gap(4).items_start()
      .child(trigger)
      .children(open ? [div().w(runsHeader.menuWidth).max_w_full().child(menu)] : [])
  }

  private rows(t: Palette, story: Extract<GalleryStory, { component: "uniformRows" }>): Element {
    const rows = visibleGalleryRows(story, this.folded)
    return v_flex().h(198).w_full().bg(t.chrome).border(1).border_color(t.border).rounded(8)
      .children(rows.length === 0 ? [div().p(8).text_color(t.muted).child("No runs in this example.")] : [])
      .child(uniformRows(story.id, rows, (row) => row.key, (row) => row.kind === "group"
        ? groupRow(t, row.key, row.status, row.count, this.folded.has(row.key))
        : runRow(t, row.key, row, this.selectedRun === row.key), { x: 6, y: 6 }, (row, cx) => {
        if (row.kind === "group") {
          if (this.folded.has(row.key)) this.folded.delete(row.key)
          else this.folded.add(row.key)
          cx.notify()
        } else {
          this.selectedRun = row.key
          this.record(`Sample run: ${row.title}`, cx)
        }
      }))
  }

  private thread(t: Palette, story: Extract<GalleryStory, { component: "threadEntry" }>): Element {
    const send = this.sendAction(story)
    if (send === null) return threadEntry(t, story.card, readOnlyThread)
    const reply = story.reply
    const controls: ThreadControls = {
      option: (_card, option, shown) => shown.cursor_pointer().on_click((_event, cx) => this.record(`Sample option: ${option.text}`, cx)),
      reply: () => [fieldWithButton(this.input, button(t, "gallery-thread-send", "Send", "primary", 32, send))],
      failure: () => reply.kind === "failed" ? [div().text_color(t.blocked).whitespace_normal().child(reply.reason)] : []
    }
    return threadEntry(t, story.card, controls)
  }

  render(t: Palette, story: GalleryStory): Element {
    const drawn = this.draw(t, story)
    const width = specimenWidths[story.component]
    return width === null ? drawn : v_flex().w_full().max_w(width).child(drawn)
  }

  private draw(t: Palette, story: GalleryStory): Element {
    switch (story.component) {
      case "button": return button(t, story.id, "Run example", story.look, story.size,
        story.disabled ? null : (cx) => this.record("Example button pressed.", cx))
      case "field": return h_flex().child(field(this.input, story.size))
      case "fieldWithButton": return fieldWithButton(this.input, button(t, story.id, story.action === "sending" ? "Sending" : "Send",
        "primary", 32, this.sendAction(story)))
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
