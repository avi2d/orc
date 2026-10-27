import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import { contextMarkSettings, modelListCommand, modelListRequest, parseModelWindows } from "../../packages/run/src/context-mark"
import { loginCheckCommand } from "../../packages/run/src/nono-profile"

const tools = { piBinary: "/host/bin/pi", nodeBinary: "/host/bin/node", homeDir: "/host/home" }

const listReply = (models: ReadonlyArray<{ readonly provider: string; readonly id: string; readonly contextWindow: number }>): string =>
  JSON.stringify({ id: "orc-models", type: "response", command: "get_available_models", success: true, data: { models } })

const settingsOf = (result: Result.Result<string, string>): unknown => JSON.parse(Result.getOrThrow(result))

describe("contextMarkSettings", () => {
  test("reserves the window above 150000 tokens instead of leaving Pi's 16384 default", () => {
    const windows = new Map([["opencode-go/muse-spark-1.3-contributor", 1_048_576]])
    expect(settingsOf(contextMarkSettings(["opencode-go/muse-spark-1.3-contributor"], windows))).toEqual({
      compaction: { modelOverrides: { "opencode-go/muse-spark-1.3-contributor": { reserveTokens: 898_576 } } }
    })
  })

  test("marks each agent model by its own window rather than sharing one reserve", () => {
    const windows = new Map([["opencode-go/glm-5.3", 1_000_000], ["opencode-go/kimi-k2.7-code", 262_144]])
    expect(settingsOf(contextMarkSettings(["opencode-go/glm-5.3", "opencode-go/kimi-k2.7-code", "opencode-go/glm-5.3"], windows))).toEqual({
      compaction: { modelOverrides: { "opencode-go/glm-5.3": { reserveTokens: 850_000 }, "opencode-go/kimi-k2.7-code": { reserveTokens: 112_144 } } }
    })
  })

  test("refuses a model pi does not list instead of writing no mark", () => {
    const result = contextMarkSettings(["opencode-go/gone"], new Map([["opencode-go/glm-5.3", 1_000_000]]))
    expect(Result.isFailure(result) && result.failure).toContain("pi lists no model opencode-go/gone")
  })

  test("refuses a window the mark does not fit in instead of writing a negative reserve", () => {
    const result = contextMarkSettings(["opencode-go/small"], new Map([["opencode-go/small", 150_000]]))
    expect(Result.isFailure(result) && result.failure).toContain("does not reach the 150000 token context mark")
  })
})

describe("parseModelWindows", () => {
  test("keys each window by provider and model id, keeping slashes inside the id", () => {
    const stdout = "pi startup notice\n" + listReply([
      { provider: "opencode-go", id: "muse-spark-1.3-contributor", contextWindow: 1_048_576 },
      { provider: "openrouter", id: "z-ai/glm-5.3", contextWindow: 1_000_000 }
    ]) + "\n"
    expect(Option.getOrThrow(parseModelWindows(stdout))).toEqual(new Map([
      ["opencode-go/muse-spark-1.3-contributor", 1_048_576],
      ["openrouter/z-ai/glm-5.3", 1_000_000]
    ]))
  })

  test("finds no list in a failed reply instead of an empty one", () => {
    const failed = JSON.stringify({ id: "orc-models", type: "response", command: "get_available_models", success: false, error: "boom" })
    expect(Option.isNone(parseModelWindows(failed + "\n"))).toBe(true)
  })
})

describe("modelListCommand", () => {
  test("asks the operator login's pi, shaped like the login check, rather than the run folder", () => {
    const list = modelListCommand(tools)
    expect(list.slice(3)).toEqual(loginCheckCommand(tools).slice(3))
    expect(list[2]?.split(";")[0]).toBe(loginCheckCommand(tools)[2]?.split(";")[0])
    expect(list[2]).toContain("--mode rpc")
    expect(JSON.parse(modelListRequest)).toEqual({ id: "orc-models", type: "get_available_models" })
  })
})
