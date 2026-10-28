import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import { checkedModelWindows, contextMarkJson, modelListRequest, parseModelWindows, type ModelWindows } from "../../packages/run/src/context-mark"

const listReply = (models: ReadonlyArray<{ readonly provider: string; readonly id: string; readonly contextWindow: number }>): string =>
  JSON.stringify({ id: "orc-models", type: "response", command: "get_available_models", success: true, data: { models } })

const settingsOf = (models: ReadonlyArray<string>, windows: ModelWindows): unknown =>
  JSON.parse(contextMarkJson(Result.getOrThrow(checkedModelWindows(models, windows))))

describe("checkedModelWindows and contextMarkJson", () => {
  test("reserves the window above 150000 tokens instead of leaving Pi's 16384 default", () => {
    const windows = new Map([["opencode-go/muse-spark-1.3-contributor", 1_048_576]])
    expect(settingsOf(["opencode-go/muse-spark-1.3-contributor"], windows)).toEqual({
      compaction: { modelOverrides: { "opencode-go/muse-spark-1.3-contributor": { reserveTokens: 898_576 } } }
    })
  })

  test("marks each agent model by its own window rather than sharing one reserve", () => {
    const windows = new Map([["opencode-go/glm-5.3", 1_000_000], ["opencode-go/kimi-k2.7-code", 262_144]])
    expect(settingsOf(["opencode-go/glm-5.3", "opencode-go/kimi-k2.7-code", "opencode-go/glm-5.3"], windows)).toEqual({
      compaction: { modelOverrides: { "opencode-go/glm-5.3": { reserveTokens: 850_000 }, "opencode-go/kimi-k2.7-code": { reserveTokens: 112_144 } } }
    })
  })

  test("refuses a model pi does not list instead of writing no mark", () => {
    const result = checkedModelWindows(["opencode-go/gone"], new Map([["opencode-go/glm-5.3", 1_000_000]]))
    expect(Result.isFailure(result) && result.failure).toContain("pi lists no model opencode-go/gone")
  })

  test("refuses a model without a provider prefix instead of writing a reserve with no window pin", () => {
    const result = checkedModelWindows(["local-model"], new Map([["opencode-go/glm-5.3", 1_000_000]]))
    expect(Result.isFailure(result) && result.failure).toContain("pi lists no model local-model")
  })

  test("refuses a window the mark does not fit in instead of writing a negative reserve", () => {
    const result = checkedModelWindows(["opencode-go/small"], new Map([["opencode-go/small", 150_000]]))
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

describe("modelListRequest", () => {
  test("sends the get_available_models request the Pi rpc server answers", () => {
    expect(JSON.parse(modelListRequest)).toEqual({ id: "orc-models", type: "get_available_models" })
  })
})
