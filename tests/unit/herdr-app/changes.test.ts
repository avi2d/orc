import { describe, expect, test } from "bun:test"
import { changeTotals, changedFiles, diffRows } from "../../../packages/herdr-app/src/changes"

const numstat = ["-\t-\tlogo.bin", "2\t1\tnotes.txt", "1\t0\tsrc/a b/new file.ts", ""].join("\0")

const notesDiff = [
  "diff --git a/notes.txt b/notes.txt",
  "index 4cb29ea..ea14db2 100644",
  "--- a/notes.txt",
  "+++ b/notes.txt",
  "@@ -1,3 +1,4 @@",
  " one",
  "-two",
  "+2",
  " three",
  "+four",
  ""
].join("\n")

const binaryDiff = [
  "diff --git a/logo.bin b/logo.bin",
  "index 8352675..c5793f9 100644",
  "Binary files a/logo.bin and b/logo.bin differ",
  ""
].join("\n")

const filesOf = (text: string) => {
  const read = changedFiles(text)
  if (read.kind === "refused") throw new Error(read.reason)
  return read.value
}

describe("the Changes column of a run", () => {
  test("lists a path with spaces whole, not cut at its first space", () => {
    expect(filesOf(numstat).map((file) => file.path)).toEqual(["logo.bin", "notes.txt", "src/a b/new file.ts"])
  })

  test("names a binary file binary rather than counting it as +0 −0", () => {
    expect(filesOf(numstat)[0]?.change).toEqual({ kind: "binary" })
  })

  test("totals the added and deleted lines of the text files, not the file count", () => {
    expect(changeTotals(filesOf(numstat))).toEqual({ added: 3, deleted: 1 })
  })

  test("a run with no changes lists no file, not one empty row", () => {
    expect(filesOf("")).toEqual([])
  })

  test("refuses a record with no counts instead of showing it as unchanged", () => {
    expect(changedFiles("notes.txt\0")).toEqual({ kind: "refused", reason: 'record 1 is "notes.txt", not added, deleted and a path' })
  })

  test("starts the diff at its first hunk, not at git's file header", () => {
    expect(diffRows(notesDiff).map((row) => `${row.kind} ${row.text}`)).toEqual([
      "hunk @@ -1,3 +1,4 @@",
      "context  one",
      "deleted -two",
      "added +2",
      "context  three",
      "added +four"
    ])
  })

  test("a binary file's diff has no rows rather than git's header lines", () => {
    expect(diffRows(binaryDiff)).toEqual([])
  })
})
