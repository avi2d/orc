import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit } from "effect"
import { parseArgs } from "../../packages/run/src/app/args"
import { decodeVersionJson, readMachineVersions } from "../../packages/run/src/features/seeing-runs/index"

const quota = { provider: "example", command: ["example-quota"], accounts: [{ name: "main", kind: "none" }] }

describe("orc version and orc machines", () => {
  test("the parser takes version --json with --local, and machines --json, and refuses each plain form", () => {
    expect(parseArgs(["version", "--json"])).toEqual({ kind: "ShowVersion" })
    expect(parseArgs(["version", "--json", "--local"])).toEqual({ kind: "ShowVersion" })
    expect(parseArgs(["version"])).toEqual({ kind: "UsageError", detail: "orc version takes --json" })
    expect(parseArgs(["version", "--local"])).toEqual({ kind: "UsageError", detail: "unexpected argument: --local" })
    expect(parseArgs(["machines", "--json"])).toEqual({ kind: "ListMachines" })
    expect(parseArgs(["machines"])).toEqual({ kind: "UsageError", detail: "orc machines takes --json" })
  })

  test("the version decoder reads an orc.version.v1 document and refuses one without a version", () => {
    expect(Effect.runSync(decodeVersionJson({ schema: "orc.version.v1", version: "1.2.3" }))).toEqual({ schema: "orc.version.v1", version: "1.2.3" })
    expect(Exit.isFailure(Effect.runSyncExit(decodeVersionJson({ schema: "orc.version.v1" })))).toBe(true)
    expect(Exit.isFailure(Effect.runSyncExit(decodeVersionJson({ schema: "orc.runs.v1", version: "1.2.3" })))).toBe(true)
  })

  test("a failed version probe reports the error without dropping the machine's slot settings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-machines-"))
    try {
      const dispatchFile = join(dir, "dispatch.json")
      await writeFile(dispatchFile, JSON.stringify({
        machines: [
          { name: "mac", slots: 1, pinnedOnly: true, start: ["orc", "runner", "start"] },
          { name: "box", slots: 0, start: ["orc", "runner", "start", "--", "sh", "-c", "echo 'orc: not installed' >&2; exit 3"] }
        ],
        quota
      }))
      const document = await Effect.runPromise(readMachineVersions(dispatchFile, "1.0.0").pipe(Effect.provide(BunServices.layer)))
      expect(document.machines[0]).toEqual({ machine: "mac", slots: 1, pinnedOnly: true, version: "1.0.0" })
      expect(document.machines[1]).toEqual({ machine: "box", slots: 0, pinnedOnly: false, error: expect.stringContaining("exited 3: orc: not installed") })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
