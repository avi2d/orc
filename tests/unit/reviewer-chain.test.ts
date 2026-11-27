import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit } from "effect"
import type { ProviderRoom } from "../../packages/run/src/shared/config/index"
import { readOrcConfig } from "../../packages/run/src/shared/config/orc-config"
import { chosenReviewerLine, NoReviewerRoom, pickChainEntry } from "../../packages/run/src/features/running-a-task/reviewer-chain"
import { roomOnProvider } from "../../packages/run/src/widgets/beat/quota"

const openai = { provider: "openai", model: "openai/gpt-5.5" }
const opencode = { provider: "opencode-go", model: "opencode-go/kimi-k2" }
const anthropic = { provider: "anthropic", model: "anthropic/claude-opus-5-5" }

const roomFrom = (rooms: Readonly<Record<string, ProviderRoom>>, asked: Array<string>) => (provider: string): Effect.Effect<ProviderRoom> => {
  asked.push(provider)
  return Effect.succeed(rooms[provider] ?? { kind: "no-room", reason: "no reading" })
}

const noRoom: ProviderRoom = { kind: "no-room", reason: "openai-main 0% left, floor 10%" }

describe("the reviewer chain", () => {
  test("picks the second entry when the first has no room, instead of the first", async () => {
    const asked: Array<string> = []
    const pick = await Effect.runPromise(pickChainEntry([openai, opencode], "anthropic", roomFrom({ openai: noRoom, "opencode-go": { kind: "room" } }, asked)))
    expect(pick.entry).toEqual(opencode)
    expect(pick.position).toBe(2)
    expect(pick.passed).toEqual([{ entry: openai, reason: "openai-main 0% left, floor 10%" }])
    expect(asked).toEqual(["openai", "opencode-go"])
  })

  test("rejects the implementer's provider while another entry has room, instead of reviewing on it", async () => {
    const asked: Array<string> = []
    const pick = await Effect.runPromise(pickChainEntry([anthropic, openai], "anthropic", roomFrom({ anthropic: { kind: "room" }, openai: { kind: "room" } }, asked)))
    expect(pick.entry).toEqual(openai)
    expect(pick.passed.map(({ entry }) => entry)).toEqual([anthropic])
    expect(asked).toEqual(["openai"])
  })

  test("fails with NoReviewerRoom when no entry has room, instead of picking one", async () => {
    const error = await Effect.runPromise(Effect.flip(pickChainEntry([anthropic, openai], "anthropic", roomFrom({ anthropic: { kind: "room" }, openai: noRoom }, []))))
    expect(error).toBeInstanceOf(NoReviewerRoom)
    expect(error.message).toContain("openai/gpt-5.5 (openai-main 0% left, floor 10%)")
  })
})

test("the run-log line names the chosen reviewer and the entries it passed over, instead of only the position", () => {
  expect(chosenReviewerLine({ entry: opencode, position: 2, passed: [{ entry: openai, reason: "openai-main 0% left, floor 10%" }] }))
    .toBe("orc: the review turn runs on opencode-go/kimi-k2, entry 2 of the reviewer chain, after passing over openai/gpt-5.5 (openai-main 0% left, floor 10%)")
})

describe("room on a provider", () => {
  const quota = { provider: "anthropic", accounts: [{ name: "claude-main" }, { name: "openai-main", provider: "openai" }] }
  const reading = (openaiPercent: number) => ({
    kind: "read" as const,
    floorPercent: 10,
    pick: null,
    accounts: [
      { account: "claude-main", kind: "usable" as const, remainingPercent: 90 },
      { account: "openai-main", kind: "usable" as const, remainingPercent: openaiPercent }
    ]
  })

  test("reads only the provider's own accounts, so another provider's room does not count", () => {
    expect(roomOnProvider(reading(5), quota, "openai")).toEqual({ kind: "no-room", reason: "openai-main 5% left, floor 10%" })
    expect(roomOnProvider(reading(40), quota, "openai")).toEqual({ kind: "room" })
  })

  test("an unread quota is no room rather than room", () => {
    expect(roomOnProvider({ kind: "unread", cause: "timeout", reason: "the quota command timed out" }, quota, "openai").kind).toBe("no-room")
  })
})

describe("the reviewers config", () => {
  const readWith = async (config: unknown) => {
    const home = await mkdtemp(join(tmpdir(), "orc-reviewers-"))
    try {
      await writeFile(join(home, "config.json"), JSON.stringify(config))
      return await Effect.runPromiseExit(readOrcConfig(home).pipe(Effect.provide(BunServices.layer)))
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }
  const providers = [{ id: "anthropic", credential: "pi-login" }, { id: "openai", credential: "pi-login" }]

  test("keeps the entries in their written order", async () => {
    const exit = await readWith({ providers, reviewers: [openai, anthropic] })
    expect(Exit.isSuccess(exit) ? exit.value.reviewers : null).toEqual([openai, anthropic])
  })

  test("refuses an entry whose model is from another provider, instead of running it", async () => {
    expect(Exit.isFailure(await readWith({ providers, reviewers: [{ provider: "openai", model: "anthropic/claude-opus-5-5" }] }))).toBe(true)
  })

  test("refuses an entry whose provider is not configured, instead of running it", async () => {
    expect(Exit.isFailure(await readWith({ providers, reviewers: [opencode] }))).toBe(true)
  })

  test("refuses an empty chain, instead of reading it as no reviewer", async () => {
    expect(Exit.isFailure(await readWith({ providers, reviewers: [] }))).toBe(true)
  })
})
