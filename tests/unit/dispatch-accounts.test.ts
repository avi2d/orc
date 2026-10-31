import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { type DispatchConfig, readDispatchConfig } from "../../packages/run/src/dispatch/config"

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
            const problem = await configProblem(root, { accounts: [{ name: "main", kind: "token-file", tokenFile: "/a", tokenCommand: ["clauth-token", "main"] }] })
      expect(problem).toContain("the account main")
      expect(problem).toContain("no excess property")
      expect(problem).toContain("tokenCommand")
    })
  })
  test("refuses a token command kind that also names a token file instead of picking one", async () => {
    await withBacklog(async (root) => {
            const problem = await configProblem(root, { accounts: [{ name: "main", kind: "token-command", tokenCommand: ["clauth-token", "main"], tokenFile: "/a" }] })
      expect(problem).toContain("the account main")
      expect(problem).toContain("no excess property")
      expect(problem).toContain("tokenFile")
    })
  })
  test("refuses a kind none account that also names a token command instead of holding it", async () => {
    await withBacklog(async (root) => {
            const problem = await configProblem(root, { accounts: [{ name: "main", kind: "none", tokenCommand: ["clauth-token", "main"] }] })
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
      await writeFile(file, JSON.stringify({ machines, quota: { ...config.quota, accounts: [{ name: "main", tokenFile: "/a" }, { name: "alt", tokenCommand: ["clauth-token", "alt"] }] } }))
      expect((await run(readDispatchConfig(file))).quota.accounts).toEqual([{ name: "main", kind: "token-file", tokenFile: "/a" }, { name: "alt", kind: "token-command", tokenCommand: ["clauth-token", "alt"] }])
    })
  })
})
