import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bypassLine, callerTool, parseStandinCall, planWords, standinMarker, type StandinCall } from "../../../packages/run/src/dispatch/heavy-standin-runtime"

const call: StandinCall = {
  tool: "cargo",
  commands: ["cargo nextest"],
  home: "/h",
  group: "heavy",
  wrap: "taskpolicy -c utility",
  real: "/usr/bin/cargo",
  through: ["winbox-heavy", "run", "--"],
  timing: { budgetMinutes: null, pollSeconds: 60 }
}

describe("parseStandinCall", () => {
  test("written settings read back whole instead of losing the commands, the through words or the timing", () => {
    expect(parseStandinCall(JSON.stringify(call))).toEqual(call)
    expect(parseStandinCall(JSON.stringify({ ...call, through: null, timing: null }))).toEqual({ ...call, through: null, timing: null })
  })

  test.each([
    [""],
    ["not json"],
    [JSON.stringify({ ...call, commands: "cargo nextest" })],
    [JSON.stringify({ ...call, through: [1] })],
    [JSON.stringify({ ...call, timing: { budgetMinutes: "30", pollSeconds: 60 } })],
    [JSON.stringify({ tool: "cargo" })]
  ])("%p reads as no call instead of a partial one", (text) => {
    expect(parseStandinCall(text)).toBeNull()
  })
})

describe("bypassLine", () => {
  test("quotes, backslashes and line breaks drop out instead of breaking the JSON line", () => {
    const line = bypassLine('fix "flaky"\\ seed\n', "bun test\tx", new Date("2026-11-11T10:00:00.123Z"))
    expect(line).toBe('{"rule":"heavy-bypass","at":"2026-11-11T10:00:00Z","reason":"fix flaky seed","command":"bun testx"}')
  })
})

describe("planWords", () => {
  test("each plan prints as the verb the stand-in reads instead of its object shape", () => {
    expect(planWords({ kind: "queue", real: "/r/my bun" })).toBe("queue /r/my bun")
    expect(planWords({ kind: "exit", code: 127 })).toBe("exit 127")
  })
})

describe("callerTool", () => {
  let root = ""

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const folders = async (): Promise<{ standins: string; copies: string; plain: string; real: string; standin: string }> => {
    root = await mkdtemp(join(tmpdir(), "orc-caller-tool-"))
    const [standins, copies, plain, real] = ["standins", "copies", "plain", "real"].map((name) => join(root, name))
    for (const folder of [standins, copies, plain, real]) {
      await mkdir(folder)
    }
    const standin = join(standins, "bun")
    await writeFile(standin, "#!/bin/sh\n# " + standinMarker + ". Regenerated on every run of that command.\n", { mode: 0o755 })
    await writeFile(join(copies, "bun"), "#!/bin/sh\n# " + standinMarker + ". Regenerated on every run of that command.\n", { mode: 0o755 })
    await writeFile(join(plain, "bun"), "not executable\n", { mode: 0o644 })
    await writeFile(join(real, "bun"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    return { standins, copies, plain, real, standin }
  }

  test("the first executable that is not a stand-in wins instead of a stand-in copy or a plain file", async () => {
    const { standins, copies, plain, real, standin } = await folders()
    expect(callerTool("bun", [standins, copies, plain, real].join(":"), standin)).toBe(join(real, "bun"))
  })

  test("the stand-in reached through a symlinked folder is skipped instead of running itself", async () => {
    const { standins, real, standin } = await folders()
    const linked = join(root, "linked")
    await symlink(standins, linked)
    await writeFile(join(standins, "bun"), "#!/bin/sh\n", { mode: 0o755 })
    expect(callerTool("bun", [linked, real].join(":"), standin)).toBe(join(real, "bun"))
  })

  test("a folder named like the tool is skipped instead of being run", async () => {
    const { real, standin } = await folders()
    await mkdir(join(root, "dirs", "bun"), { recursive: true })
    expect(callerTool("bun", [join(root, "dirs"), real].join(":"), standin)).toBe(join(real, "bun"))
  })

  test("a PATH with no other copy finds nothing instead of the stand-in", async () => {
    const { standins, copies, standin } = await folders()
    expect(callerTool("bun", [standins, copies].join(":"), standin)).toBe("")
    expect(callerTool("bun", "", standin)).toBe("")
  })
})
