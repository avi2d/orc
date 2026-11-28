import { expect, test } from "bun:test"
import { closedOverlays, cx, nodes, press, pressKey, viewProps } from "./gpui-fakes"

const shows = (element: object | string, text: string): boolean =>
  typeof element === "string" ? element === text : nodes.get(element)?.kids.some((kid) => shows(kid, text)) === true

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

test("Escape closes the gallery after a control click instead of being lost on an unfocused root", async () => {
  const { default: DesignSystem } = await import("../../../packages/herdr-app/mods/orc-design-system/main")
  const gallery = new DesignSystem()
  const before = closedOverlays.length
  viewProps.set("overlay", "test-gallery")
  try {
    gallery.init({}, cx)
    press(gallery, "gallery-page-2")
    press(gallery, "control-height-24")
    pressKey(gallery, "escape")
    expect(closedOverlays.slice(before)).toEqual(["test-gallery"])
  } finally {
    gallery.close(cx)
    viewProps.delete("overlay")
  }
})
