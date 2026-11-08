import { describe, expect, test } from "bun:test"

// The retired name is built from parts so this guard never spells it and never fails on itself.
const syllables = ["t", "u", "i", "[-_]?", "d", "a", "s", "h"]
const retired = new RegExp(syllables.join(""), "i")

describe("the retired dashboard name", () => {
  test("no tracked path or content keeps the retired name instead of the orc-dash name", () => {
    const root = new URL("../..", import.meta.url).pathname
    const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root })
    if (!listed.success) throw new Error("git ls-files refused to list the tracked files")
    const files = Buffer.from(listed.stdout).toString("utf8").split("\0").filter((file) => file.length > 0 && file !== "CHANGELOG.md")
    expect(files.filter((file) => retired.test(file))).toEqual([])
    const searched = Bun.spawnSync(["git", "grep", "-l", "-i", "-E", syllables.join(""), "--", ".", ":(exclude)CHANGELOG.md"], {
      cwd: root,
    })
    if (searched.exitCode === 0) {
      expect(Buffer.from(searched.stdout).toString("utf8").trim().split("\n")).toEqual([])
    } else {
      expect(searched.exitCode).toBe(1)
    }
  })
})
