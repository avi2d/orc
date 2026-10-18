import { describe, expect, test } from "bun:test"
import { parseArgs } from "../../src/args"

describe("parseArgs", () => {
  test("no flag is a usage error", () => {
    expect(parseArgs([])).toEqual({ kind: "UsageError", detail: "orc takes one flag" })
  })

  test("--version prints the version", () => {
    expect(parseArgs(["--version"])).toEqual({ kind: "PrintVersion" })
  })

  test("--help prints the usage text", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "PrintHelp" })
  })

  test("-h prints the usage text", () => {
    expect(parseArgs(["-h"])).toEqual({ kind: "PrintHelp" })
  })

  test("an unknown flag is a usage error", () => {
    expect(parseArgs(["--frobnicate"])).toEqual({ kind: "UsageError", detail: "unknown flag: --frobnicate" })
  })

  test("an extra argument is a usage error", () => {
    expect(parseArgs(["--version", "extra"])).toEqual({ kind: "UsageError", detail: "unexpected argument: extra" })
  })
})
