import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit } from "effect"
import { type Account, defaultCredentialOf, type ProviderRoom, type ReviewerCredential } from "../../packages/run/src/shared/config/index"
import { readOrcConfig } from "../../packages/run/src/shared/config/orc-config"
import { chosenReviewerLine, NoReviewerRoom, pickChainEntry } from "../../packages/run/src/features/running-a-task/reviewer-chain"
import { type QuotaReading, roomOnCredential } from "../../packages/run/src/widgets/beat/quota"

const openai = { provider: "openai", model: "openai/gpt-5.5" }
const opencode = { provider: "opencode-go", model: "opencode-go/kimi-k2" }
const anthropic = { provider: "anthropic", model: "anthropic/claude-opus-5-5" }

const roomFrom = (rooms: Readonly<Record<string, ProviderRoom>>, asked: Array<string>) => ({ provider }: { readonly provider: string }): ProviderRoom => {
  asked.push(provider)
  return rooms[provider] ?? { kind: "no-room", reason: "no reading" }
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

describe("room on the reviewer's default credential", () => {
  const accounts: ReadonlyArray<Account> = [
    { name: "claude-a", kind: "claude-config", configDirs: { studio: "/accounts/claude-a" } },
    { name: "claude-b", kind: "claude-config", configDirs: { studio: "/accounts/claude-b" } },
    { name: "openai-main", provider: "openai", kind: "token-file", tokenFile: "/tokens/openai-main" },
    { name: "openai-spare", provider: "openai", kind: "token-file", tokenFile: "/tokens/openai-spare" },
    { name: "opencode-main", provider: "opencode-go", kind: "none" }
  ]
  const quota = { provider: "anthropic", accounts }
  const reading = (percents: Readonly<Record<string, number>>): QuotaReading => ({
    kind: "read",
    floorPercent: 10,
    pick: null,
    accounts: accounts.map((account) => ({ account: account.name, kind: "usable" as const, remainingPercent: percents[account.name] ?? 50 }))
  })
  const claudeA: ReviewerCredential = { provider: "anthropic", credential: { kind: "claude-config", configDir: "/accounts/claude-a" } }
  const openaiMain: ReviewerCredential = { provider: "openai", credential: { kind: "token-file", tokenFile: "/tokens/openai-main", origin: "config.json" } }

  test("rejects picking a provider whose default credential has no room while another of its accounts has room, instead of counting that account", async () => {
    const chain = [{ ...anthropic, ...claudeA }, { ...openai, ...openaiMain }] as const
    const pick = await Effect.runPromise(pickChainEntry(chain, "opencode-go", (entry) => roomOnCredential(reading({ "claude-a": 3, "claude-b": 80 }), quota, entry)))
    expect(pick.entry.provider).toBe("openai")
    expect(pick.passed).toEqual([{ entry: chain[0], reason: "claude-a 3% left, floor 10%" }])
  })

  test("reads the token-file account that holds the provider's default token file, instead of its spare", () => {
    expect(roomOnCredential(reading({ "openai-main": 5, "openai-spare": 90 }), quota, openaiMain)).toEqual({ kind: "no-room", reason: "openai-main 5% left, floor 10%" })
    expect(roomOnCredential(reading({ "openai-main": 40, "openai-spare": 0 }), quota, openaiMain)).toEqual({ kind: "room" })
  })

  test("a default credential no quota account holds is no room, instead of borrowing another account's room", () => {
    const elsewhere: ReviewerCredential = { provider: "anthropic", credential: { kind: "claude-config", configDir: "/accounts/claude-c" } }
    expect(roomOnCredential(reading({}), quota, elsewhere)).toEqual({ kind: "no-room", reason: "no quota account on anthropic holds its default Claude config folder /accounts/claude-c" })
  })

  test("a provider with no credential to match counts its one account, and refuses to guess among several", () => {
    expect(roomOnCredential(reading({}), quota, { provider: "opencode-go", credential: { kind: "only-account" } })).toEqual({ kind: "room" })
    expect(roomOnCredential(reading({}), quota, { provider: "anthropic", credential: { kind: "only-account" } }).kind).toBe("no-room")
  })

  test("an unread quota is no room rather than room", () => {
    expect(roomOnCredential({ kind: "unread", cause: "timeout", reason: "the quota command timed out" }, quota, openaiMain).kind).toBe("no-room")
  })
})

describe("a reviewer's default credential", () => {
  test("is the token file its provider names, or the one its variable names, instead of none", () => {
    expect(defaultCredentialOf({ id: "openai", credential: "token-file", tokenFile: { path: "/tokens/openai" } }, {}, "config.json"))
      .toEqual({ kind: "token-file", tokenFile: "/tokens/openai", origin: "config.json" })
    expect(defaultCredentialOf({ id: "openai", credential: "token-file", tokenFile: { env: "OPENAI_TOKEN_FILE" } }, { OPENAI_TOKEN_FILE: "/tokens/env" }, "config.json"))
      .toEqual({ kind: "token-file", tokenFile: "/tokens/env", origin: "the variable OPENAI_TOKEN_FILE" })
  })

  test("is the Claude config folder a package provider's env names, and no folder without one", () => {
    expect(defaultCredentialOf({ id: "anthropic", credential: "package", packages: ["npm:pi-claude"], env: { CLAUDE_CONFIG_DIR: "/accounts/claude-a" } }, {}, "config.json"))
      .toEqual({ kind: "claude-config", configDir: "/accounts/claude-a" })
    expect(defaultCredentialOf({ id: "anthropic", credential: "package", packages: ["npm:pi-claude"] }, {}, "config.json")).toEqual({ kind: "only-account" })
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

  test.each([{}, { review: {} }])("an omitted round limit defaults to two rather than remaining unset: %j", async (settings) => {
    const exit = await readWith({ providers, ...settings })
    expect(Exit.isSuccess(exit) ? exit.value : null).toMatchObject({ review: { maxFixRounds: 2 } })
  })

  test.each([1, 3])("keeps the configured round limit %s rather than replacing it with two", async (maxFixRounds) => {
    const exit = await readWith({ providers, review: { maxFixRounds } })
    expect(Exit.isSuccess(exit) ? exit.value : null).toMatchObject({ review: { maxFixRounds } })
  })

  test.each([0, -1, 1.5, "2", null])("refuses an invalid round limit rather than running an unbounded loop: %j", async (maxFixRounds) => {
    expect(Exit.isFailure(await readWith({ providers, review: { maxFixRounds } }))).toBe(true)
  })

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
