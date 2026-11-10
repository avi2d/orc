import { describe, expect, test } from "bun:test"
import { join, relative } from "node:path"
import { nonoFixtureRoot } from "../lib/nono-home"

const checkout = join(import.meta.dir, "..", "..")
const insideCheckout = (path: string): boolean => !relative(checkout, path).startsWith("..")
const underGrantedTemp = (path: string): boolean => /^\/(private\/)?(tmp|var)(\/|$)/.test(path)

describe("the nono fixture root", () => {
  test("sits outside the checkout, so a killed run leaves no fixture for git add to pick up", () => {
    expect(insideCheckout(nonoFixtureRoot())).toBe(false)
  })

  test("never sits under the macOS or Linux temp dir nono grants and refuses as a HOME", () => {
    for (const systemTmp of ["/var/folders/xy/T", "/private/var/folders/xy/T", "/tmp"]) {
      expect(underGrantedTemp(nonoFixtureRoot(systemTmp))).toBe(false)
    }
  })

  test("takes an orc sandbox's own TMPDIR instead of the account cache the sandbox denies", () => {
    expect(nonoFixtureRoot("/home/dev/.orc/runs/r1/session/tmp")).toBe("/home/dev/.orc/runs/r1/session/tmp")
  })
})
