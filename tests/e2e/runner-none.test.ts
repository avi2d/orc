import { describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { binPath, fakeQuota, type Fixture, type OrcResult, orcOk, queuedArgs, runnerTimeout, runOrc, withFixture } from "./runner-helpers"

const queueWith = (fixture: Fixture, request: object, env: Record<string, string> = {}): Promise<OrcResult> =>
  runOrc(fixture, ["runner", "queue"], env, JSON.stringify(request))

const mainToken = "/secrets/main-token"

describe("orc runner queue for a kind none account", () => {
  const bareRunArgs = (fixture: Fixture, task: string, provider: string): Array<string> => [
    "--group", "orc", "--label", fixture.home + " " + task, "--working-directory", fixture.checkout, "--print-task-id", "--escape", "--",
    process.execPath, binPath, "run", join(fixture.home, "runner", task + ".md"), "--branch", "orc/" + task,
    "--sandbox", "none", "--provider", provider
  ]

  test("queues a request with no token and no --token-file instead of holding a token", async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.home, "config.json"), JSON.stringify({
        providers: [{ id: "acme", credential: "package", packages: ["git:example.test/acme/tools@v1.2.0"], env: { ACME_ACCOUNT_DIR: "/accounts/main" } }],
        models: { implementer: "acme/coder-3", fixer: "acme/coder-3" }
      }))
      const result = await queueWith(fixture, { task: "task-9", checkout: fixture.checkout, provider: "acme", body: "# x\n" })
      expect(result.exitCode).toBe(0)
      expect((await readFile(join(fixture.pueue, "add-args"), "utf8")).split("\n").slice(0, -1)).toEqual(bareRunArgs(fixture, "task-9", "acme"))
      expect(await Bun.file(join(fixture.home, "runner", "tokens", "task-9", "token")).exists()).toBe(false)
    })
  }, runnerTimeout)

  test("refuses the queue while the orc config is invalid instead of starting the run", async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.home, "config.json"), JSON.stringify({ providers: [{ id: "acme", credential: "bogus" }] }))
      const result = await queueWith(fixture, { task: "task-9", checkout: fixture.checkout, provider: "acme", token: "tokenA123", expiresAt: "2027-01-01T00:00:00.000Z", body: "# x\n" })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain(join(fixture.home, "config.json"))
      expect(await Bun.file(join(fixture.home, "runner", "tokens", "task-9", "token")).exists()).toBe(false)
    })
  }, runnerTimeout)

  test("queues the run with --token-file instead of dropping the account token file", async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.home, "config.json"), JSON.stringify({
        providers: [{ id: "acme", credential: "token-file", tokenFile: { env: "ACME_TOKEN_FILE" } }]
      }))
      const result = await queueWith(fixture, { task: "task-9", checkout: fixture.checkout, provider: "acme", tokenFile: mainToken, body: "# x\n" })
      expect(result.exitCode).toBe(0)
      expect((await readFile(join(fixture.pueue, "add-args"), "utf8")).split("\n").slice(0, -1)).toEqual([...bareRunArgs(fixture, "task-9", "acme"), "--token-file", mainToken])
    })
  }, runnerTimeout)

  test("a beat start for a kind none account queues with no --token-file and renews nothing", async () => {
    await withFixture(async (fixture) => {
      await fakeQuota(fixture)
      await writeFile(join(fixture.home, "backlog", "dispatch.json"), JSON.stringify({
        machines: [{ name: "linux", slots: 1, start: [process.execPath, binPath, "runner", "start"] }],
        quota: { provider: "acme", command: ["orc-quota"], accounts: [{ name: "main", kind: "none" }], floorPercent: 15 }
      }))
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
      await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--machine", "linux"])
      await orcOk(fixture, ["beat"])
      expect(await queuedArgs(fixture)).toEqual(bareRunArgs(fixture, "task-1", "acme"))
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({
        tasks: {
          "77": {
            id: 77,
            label: fixture.home + " task-1",
            group: "orc",
            path: fixture.checkout,
            status: { Running: { start: "2026-10-28T02:36:39.176448491+03:00" } }
          }
        },
        groups: {}
      }))
      const second = await orcOk(fixture, ["beat"])
      expect(second).not.toContain("renew")
      expect(await Bun.file(join(fixture.home, "runner", "tokens", "task-1", "token")).exists()).toBe(false)
    })
  }, runnerTimeout)
})
