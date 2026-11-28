import { expect, test } from "bun:test"
import { cx, executed, find, nodes, press, pressKey, ran } from "./gpui-fakes"

const shows = (element: object | string, text: string): boolean =>
  typeof element === "string" ? element === text : nodes.get(element)?.kids.some((kid) => shows(kid, text)) === true

const toOrc = { name: "layout.switch", args: { name: "orc" } }

test("switching gallery pages does not show the other page's receipt or clear its own receipt", async () => {
  const { default: DesignSystem } = await import("../../../packages/herdr-app/mods/orc-design-system/main")
  const gallery = new DesignSystem()
  gallery.init({}, cx)
  try {
    press(gallery, "choose-button.32.primary.enabled")
    press(gallery, "button.32.primary.enabled")
    expect(shows(gallery.render(), "Example button pressed.")).toBe(true)
    press(gallery, "gallery-page-2")
    expect(shows(gallery.render(), "Example button pressed.")).toBe(false)
    press(gallery, "control-height-32")
    expect(shows(gallery.render(), "32 px example button pressed.")).toBe(true)
    press(gallery, "gallery-page-0")
    expect(shows(gallery.render(), "32 px example button pressed.")).toBe(false)
    expect(shows(gallery.render(), "Example button pressed.")).toBe(true)
    press(gallery, "gallery-page-2")
    expect(shows(gallery.render(), "32 px example button pressed.")).toBe(true)
  } finally {
    gallery.close(cx)
  }
})

test("Escape returns to the Orc layout after a control click instead of being lost on an unfocused root", async () => {
  const { default: DesignSystem } = await import("../../../packages/herdr-app/mods/orc-design-system/main")
  const gallery = new DesignSystem()
  const before = ran.length
  try {
    gallery.init({}, cx)
    press(gallery, "gallery-page-2")
    press(gallery, "control-height-24")
    pressKey(gallery, "escape")
    expect(ran.slice(before)).toEqual([toOrc])
  } finally {
    gallery.close(cx)
  }
})

test("Escape closes an open sample project menu first instead of leaving the gallery with it open", async () => {
  const { default: DesignSystem } = await import("../../../packages/herdr-app/mods/orc-design-system/main")
  const gallery = new DesignSystem()
  const before = ran.length
  try {
    gallery.init({}, cx)
    press(gallery, "choose-select-trigger.24")
    press(gallery, "select-trigger.24")
    expect(find(gallery.render(), "gallery-project-menu")).not.toBeNull()
    pressKey(gallery, "escape")
    expect(find(gallery.render(), "gallery-project-menu")).toBeNull()
    expect(ran.slice(before)).toEqual([])
    pressKey(gallery, "escape")
    expect(ran.slice(before)).toEqual([toOrc])
  } finally {
    gallery.close(cx)
  }
})

test("picking a sample project stays in the gallery instead of filtering runs or running an Orc command", async () => {
  const { default: DesignSystem } = await import("../../../packages/herdr-app/mods/orc-design-system/main")
  const gallery = new DesignSystem()
  const commands = { ran: ran.length, executed: executed.length }
  try {
    gallery.init({}, cx)
    press(gallery, "choose-select-trigger.24")
    press(gallery, "select-trigger.24")
    press(gallery, "gallery-project-garden")
    const shown = gallery.render()
    expect(shows(shown, "Sample project: garden")).toBe(true)
    expect(find(shown, "gallery-project-menu")).toBeNull()
    expect({ ran: ran.length, executed: executed.length }).toEqual(commands)
  } finally {
    gallery.close(cx)
  }
})

test("pressing the open sample project trigger closes its menu instead of reopening it", async () => {
  const { default: DesignSystem } = await import("../../../packages/herdr-app/mods/orc-design-system/main")
  const gallery = new DesignSystem()
  try {
    gallery.init({}, cx)
    press(gallery, "choose-select-trigger.24")
    press(gallery, "select-trigger.24")
    press(gallery, "select-trigger.24")
    expect(find(gallery.render(), "gallery-project-menu")).toBeNull()
  } finally {
    gallery.close(cx)
  }
})

test("Back to Orc and the top bar entry switch layouts instead of opening a window over the board", async () => {
  const { default: DesignSystem } = await import("../../../packages/herdr-app/mods/orc-design-system/main")
  const { default: OrcTabs } = await import("../../../packages/herdr-app/mods/orc-tabs/main")
  const gallery = new DesignSystem()
  const before = ran.length
  try {
    gallery.init({}, cx)
    press(new OrcTabs(), "open-orc-design-system")
    press(gallery, "gallery-back")
    expect(ran.slice(before)).toEqual([{ name: "layout.switch", args: { name: "orc-design-system" } }, toOrc])
  } finally {
    gallery.close(cx)
  }
})
