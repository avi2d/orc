import { describe, expect, test } from "bun:test"
import { Effect, Result } from "effect"
import { sandboxReadFolders } from "../../packages/run/src/sandbox-plan"

const readFolders = (read: ReadonlyArray<string>) =>
  Effect.runSync(Effect.result(sandboxReadFolders({ file: "/Users/me/.orc/config.json", sandbox: { read } }, "/Users/me")))

describe("sandboxReadFolders", () => {
  test("grants a folder inside HOME instead of refusing every home folder", () => {
    expect(readFolders(["/Users/me/.cache/avi2dg-checks/"])).toEqual(Result.succeed(["/Users/me/.cache/avi2dg-checks"]))
  })

  test("refuses HOME itself and the folders above it instead of handing the sandbox the operator's credentials", () => {
    for (const folder of ["/Users/me", "/Users/me/", "/Users", "/"]) {
      const result = readFolders([folder])
      expect(Result.isFailure(result) ? result.failure.message : "granted").toContain("which holds HOME")
    }
  })

  test("refuses nothing when the config lists no sandbox folders", () => {
    expect(Effect.runSync(sandboxReadFolders({ file: "/Users/me/.orc/config.json" }, "/Users/me"))).toEqual([])
  })
})
