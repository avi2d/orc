import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit } from "effect"
import { parseArgs } from "../../packages/run/src/app/args"
import { decodeVersionJson, formatMachinesTable, readMachineVersions } from "../../packages/run/src/features/seeing-runs/index"

const quota = { provider: "example", command: ["example-quota"], accounts: [{ name: "main", kind: "none" }] }

describe("orc version and orc machines", () => {
  test("the parser takes version with --json and --local, and machines with --json", () => {
    expect(parseArgs(["version"])).toEqual({ kind: "ShowVersion", json: false })
    expect(parseArgs(["version", "--json", "--local"])).toEqual({ kind: "ShowVersion", json: true })
    expect(parseArgs(["version", "--local"])).toEqual({ kind: "UsageError", detail: "unexpected argument: --local" })
    expect(parseArgs(["machines", "--json"])).toEqual({ kind: "ListMachines", json: true })
  })

  test("the version decoder reads an orc.version.v1 document and refuses one without a version", () => {
    expect(Effect.runSync(decodeVersionJson({ schema: "orc.version.v1", version: "1.2.3" }))).toEqual({ schema: "orc.version.v1", version: "1.2.3" })
    expect(Exit.isFailure(Effect.runSyncExit(decodeVersionJson({ schema: "orc.version.v1" })))).toBe(true)
    expect(Exit.isFailure(Effect.runSyncExit(decodeVersionJson({ schema: "orc.runs.v1", version: "1.2.3" })))).toBe(true)
  })

  test("a machine whose through command fails is listed with its error beside the local machine's version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-machines-"))
    try {
      const dispatchFile = join(dir, "dispatch.json")
      await writeFile(dispatchFile, JSON.stringify({
        machines: [
          { name: "mac", slots: 1, start: ["orc", "runner", "start"] },
          { name: "box", slots: 1, start: ["orc", "runner", "start", "--", "sh", "-c", "echo 'orc: not installed' >&2; exit 3"] }
        ],
        quota
      }))
      const document = await Effect.runPromise(readMachineVersions(dispatchFile, "1.0.0").pipe(Effect.provide(BunServices.layer)))
      expect(document.machines[0]).toEqual({ machine: "mac", version: "1.0.0" })
      expect(document.machines[1]).toEqual({ machine: "box", error: expect.stringContaining("exited 3: orc: not installed") })
      expect(formatMachinesTable(document)).toContain("box      error: ")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
