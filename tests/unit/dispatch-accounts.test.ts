import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { type DispatchConfig, providerOf, readDispatchConfig } from "../../packages/run/src/shared/config/dispatch-config"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const withBacklog = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-dispatch-"))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const config: DispatchConfig = {
  machines: [{ name: "mac", slots: 1, start: ["true"] }, { name: "linux", slots: 4, start: ["true"] }],
  quota: { provider: "keyed", command: ["orc-quota"], accounts: [{ name: "main", kind: "token-file", tokenFile: "/secrets/main-token" }], floorPercent: 15 }
}

const configProblem = async (root: string, quota: object): Promise<string | null> => {
  const file = join(root, "dispatch.json")
  await writeFile(file, JSON.stringify({ machines: config.machines, quota: { ...config.quota, ...quota } }))
  return run(readDispatchConfig(file).pipe(
    Effect.map(() => null),
    Effect.catchTag("ConfigError", (error) => Effect.succeed(error.detail))
  ))
}

describe("readDispatchConfig", () => {
  test("accepts a quota without a floor instead of requiring a percentage", async () => {
    await withBacklog(async (root) => {
      const file = join(root, "dispatch.json")
      const { floorPercent: _, ...quota } = config.quota
      await writeFile(file, JSON.stringify({ machines: config.machines, quota }))
      expect((await run(readDispatchConfig(file))).quota.floorPercent).toBe(0)
    })
  })
  test("refuses a Claude account missing a machine directory instead of choosing an unspecified login", async () => {
    await withBacklog(async (root) => {
      const problem = await configProblem(root, { accounts: [{ name: "main", kind: "claude-config", configDirs: { mac: "/accounts/main" } }] })
      expect(problem).toContain("names no Claude config directory for linux")
    })
  })
  test("reads a legacy token file account as kind token-file instead of refusing it", async () => {
    await withBacklog(async (root) => {
      const file = join(root, "dispatch.json")
      await writeFile(file, JSON.stringify({ machines: config.machines, quota: { ...config.quota, accounts: [{ name: "main", tokenFile: "/secrets/main-token" }] } }))
      expect((await run(readDispatchConfig(file))).quota.accounts).toEqual([{ name: "main", kind: "token-file", tokenFile: "/secrets/main-token" }])
    })
  })
  test("keeps an explicit token file kind on the account that names it", async () => {
    await withBacklog(async (root) => {
      const file = join(root, "dispatch.json")
      await writeFile(file, JSON.stringify({ machines: config.machines, quota: { ...config.quota, accounts: [{ name: "main", kind: "token-file", tokenFile: "/a" }] } }))
      expect((await run(readDispatchConfig(file))).quota.accounts).toEqual([{ name: "main", kind: "token-file", tokenFile: "/a" }])
    })
  })
  test("keeps a kind none account once no machine names a renew command", async () => {
    await withBacklog(async (root) => {
      const file = join(root, "dispatch.json")
      await writeFile(file, JSON.stringify({ machines: config.machines, quota: { ...config.quota, accounts: [{ name: "main", kind: "none" }] } }))
      expect((await run(readDispatchConfig(file))).quota.accounts).toEqual([{ name: "main", kind: "none" }])
    })
  })
  test("refuses a token file kind with no token file instead of starting its runs on none", async () => {
    await withBacklog(async (root) => {
            const problem = await configProblem(root, { accounts: [{ name: "main", kind: "token-file" }] })
      expect(problem).toContain("the account main")
      expect(problem).toContain("Missing key")
      expect(problem).toContain("tokenFile")
    })
  })
  test("refuses a token command kind with no token command instead of starting its runs on none", async () => {
    await withBacklog(async (root) => {
            const problem = await configProblem(root, { accounts: [{ name: "main", kind: "token-command" }] })
      expect(problem).toContain("the account main")
      expect(problem).toContain("Missing key")
      expect(problem).toContain("tokenCommand")
    })
  })
  test("refuses a token file kind that also names a token command instead of picking one", async () => {
    await withBacklog(async (root) => {
            const problem = await configProblem(root, { accounts: [{ name: "main", kind: "token-file", tokenFile: "/a", tokenCommand: ["my-token-command", "main"] }] })
      expect(problem).toContain("the account main")
      expect(problem).toContain("no excess property")
      expect(problem).toContain("tokenCommand")
    })
  })
  test("refuses a token command kind that also names a token file instead of picking one", async () => {
    await withBacklog(async (root) => {
            const problem = await configProblem(root, { accounts: [{ name: "main", kind: "token-command", tokenCommand: ["my-token-command", "main"], tokenFile: "/a" }] })
      expect(problem).toContain("the account main")
      expect(problem).toContain("no excess property")
      expect(problem).toContain("tokenFile")
    })
  })
  test("refuses a kind none account that also names a token command instead of holding it", async () => {
    await withBacklog(async (root) => {
            const problem = await configProblem(root, { accounts: [{ name: "main", kind: "none", tokenCommand: ["my-token-command", "main"] }] })
      expect(problem).toContain("the account main")
      expect(problem).toContain("no excess property")
      expect(problem).toContain("tokenCommand")
    })
  })
  test("refuses a kind none account that also names a token file instead of holding it", async () => {
    await withBacklog(async (root) => {
            const problem = await configProblem(root, { accounts: [{ name: "main", kind: "none", tokenFile: "/a" }] })
      expect(problem).toContain("the account main")
      expect(problem).toContain("no excess property")
      expect(problem).toContain("tokenFile")
    })
  })
  test("refuses an account name the schema cannot take instead of keeping it", async () => {
    await withBacklog(async (root) => {
      const problem = await configProblem(root, { accounts: [{ name: "main!", tokenFile: "/a" }] })
      expect(problem).toContain("the account main!")
      expect(problem).toContain("RegExp")
    })
  })
  test("refuses a kind none account while a machine names a renew command instead of keeping dead renewal", async () => {
    await withBacklog(async (root) => {
      const file = join(root, "dispatch.json")
      const machines = config.machines.map((machine) => ({ ...machine, renew: ["true"] }))
      await writeFile(file, JSON.stringify({ machines, quota: { ...config.quota, accounts: [{ name: "main", kind: "none" }] } }))
      const read = await run(readDispatchConfig(file).pipe(Effect.as("read"), Effect.catchTag("ConfigError", (error) => Effect.succeed(error.detail))))
      expect(read).toBe("the account main takes kind none and holds no token, so the machine mac names a renew command it never takes")
    })
  })
  test("refuses a second account beside a kind none account instead of spending the wrong login", async () => {
    await withBacklog(async (root) => {
      expect(await configProblem(root, { accounts: [{ name: "main", kind: "none" }, { name: "alt", kind: "none" }] })).toBe(
        "the account main takes kind none and names no login, so the quota names no other account beside it"
      )
    })
  })
  test("refuses a token account beside a kind none account instead of spending the wrong login", async () => {
    await withBacklog(async (root) => {
      expect(await configProblem(root, { accounts: [{ name: "main", tokenFile: "/a" }, { name: "alt", kind: "none" }] })).toBe(
        "the account alt takes kind none and names no login, so the quota names no other account beside it"
      )
    })
  })
  test("keeps several token accounts when no account is kind none", async () => {
    await withBacklog(async (root) => {
      const file = join(root, "dispatch.json")
      const machines = config.machines.map((machine) => ({ ...machine, renew: ["true"] }))
      await writeFile(file, JSON.stringify({ machines, quota: { ...config.quota, accounts: [{ name: "main", tokenFile: "/a" }, { name: "alt", tokenCommand: ["my-token-command", "alt"] }] } }))
      expect((await run(readDispatchConfig(file))).quota.accounts).toEqual([{ name: "main", kind: "token-file", tokenFile: "/a" }, { name: "alt", kind: "token-command", tokenCommand: ["my-token-command", "alt"] }])
    })
  })
  test("keeps an account's own provider and falls back to the quota provider instead of one provider for every account", async () => {
    await withBacklog(async (root) => {
      const file = join(root, "dispatch.json")
      const models = { implementer: "codex/gpt-5.5", fixer: "codex/gpt-5.5" }
      await writeFile(file, JSON.stringify({ machines: config.machines, quota: { ...config.quota, accounts: [{ name: "main", tokenFile: "/a" }, { name: "openai", provider: "codex", models, tokenFile: "/b" }] } }))
      const quota = (await run(readDispatchConfig(file))).quota
      expect(quota.accounts.map((account) => providerOf(quota, account))).toEqual(["keyed", "codex"])
    })
  })
  test("refuses an account provider that is no provider id instead of handing it to the run", async () => {
    await withBacklog(async (root) => {
      expect(await configProblem(root, { accounts: [{ name: "main", provider: "no such", tokenFile: "/a" }] })).toContain("the account main")
    })
  })
  test("refuses an account on another provider that names no models instead of running it on the quota provider's models", async () => {
    await withBacklog(async (root) => {
      expect(await configProblem(root, { accounts: [{ name: "main", tokenFile: "/a" }, { name: "openai", provider: "codex", tokenFile: "/b" }] }))
        .toBe("the account openai runs on the provider codex, not the quota's provider keyed, so it names the implementer and fixer models from codex for its runs")
    })
  })
  test("refuses an account model from another provider instead of handing the run a model its credential cannot reach", async () => {
    await withBacklog(async (root) => {
      const models = { implementer: "codex/gpt-5.5", fixer: "keyed/claude-sonnet" }
      expect(await configProblem(root, { accounts: [{ name: "openai", provider: "codex", models, tokenFile: "/b" }] }))
        .toBe("the account openai runs on the provider codex and names the model keyed/claude-sonnet, which is not from codex")
    })
  })
})
