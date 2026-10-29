import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path, Result } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { routeOfAgents } from "../../packages/run/src/model-route"
import { buildAgentNonoProfile } from "../../packages/run/src/nono-profile"
import { readOrcConfig } from "../../packages/run/src/orc-config"
import { planSandbox } from "../../packages/run/src/sandbox-plan"

describe("configured credential injection", () => {
  test("falls back to Authorization Bearer instead of the configured X-Api-Key injection", async () => {
    const root = await mkdtemp(join(tmpdir(), "orc-nono-configured-"))
    try {
      const orcHome = join(root, "orc-home")
      const projectDir = join(root, "project")
      const runDir = join(root, "run")
      const piAgentDir = join(root, "agent")
      const operatorHome = join(root, "operator")
      const fakeBin = join(root, "bin")
      for (const dir of [orcHome, projectDir, runDir, piAgentDir, operatorHome, fakeBin]) {
        await mkdir(dir, { recursive: true })
      }
      const fixtureKey = "<fixture-key>"
      const modelListReply = JSON.stringify({ id: "orc-models", type: "response", command: "get_available_models", success: true, data: { models: [{ provider: "acme-vault", id: "coder-1", contextWindow: 262144 }] } })
      await writeFile(join(fakeBin, "pi"), ["#!/bin/sh", "if [ \"$1\" = auth ] && [ \"$2\" = check ]; then exit 0; fi", "if [ \"$1\" = auth ]; then echo '" + fixtureKey + "'; exit 0; fi", "if [ \"$1\" = --mode ]; then cat > /dev/null; echo '" + modelListReply + "'; exit 0; fi", "exit 2"].join("\n") + "\n")
      await chmod(join(fakeBin, "pi"), 0o755)
      await writeFile(join(orcHome, "config.json"), JSON.stringify({ providers: [{ id: "acme-vault", credential: "pi-login", nono: { upstream: "https://llm.acme.test/vault", injectHeader: "X-Api-Key", credentialFormat: "{}" } }], models: { implementer: "acme-vault/coder-1", fixer: "acme-vault/coder-1" } }))
      const hostTools = { piBinary: join(fakeBin, "pi"), nodeBinary: "/bin/sh", homeDir: operatorHome }
      const models = { agent: "acme-vault/coder-1", fixer: "acme-vault/coder-1" }
      const config = await Effect.runPromise(readOrcConfig(orcHome).pipe(Effect.provide(BunServices.layer)))
      const provider = Result.getOrThrow(routeOfAgents(config, models, undefined))
      const plan = await Effect.runPromise(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        return yield* planSandbox(fs, path, spawner, hostTools, { projectDir, runDir, piAgentDir }, models, { config, provider, tokenFileFlag: undefined }, "nono")
      }).pipe(Effect.provide(BunServices.layer)))
      if (plan.kind !== "nono") {
        throw new Error("the login provider planned no nono credential")
      }
      expect(plan.credential.injectHeader).toBe("X-Api-Key")
      expect(plan.credential.credentialFormat).toBe("{}")
      const captured = Bun.spawnSync([...plan.credential.captureCommand], { stdout: "pipe", stderr: "pipe" })
      expect(captured.exitCode).toBe(0)
      expect(captured.stdout.toString().trim()).toBe(fixtureKey)
      const written = await readFile(join(piAgentDir, "models.json"), "utf8")
      expect(written).toContain("$ACME_VAULT_KEY")
      expect(written).not.toContain(fixtureKey)
      const profile = await Effect.runPromise(buildAgentNonoProfile({ worktree: join(root, "work"), gitData: join(root, "work.git"), piSessionDir: join(root, "session") }, { developerDir: null, toolchainFolders: [], runtimeDirs: [] }, plan.credential).pipe(Effect.provide(BunServices.layer)))
      expect(profile.network.credentials).toEqual(["acme_vault"])
      expect(profile.network.custom_credentials).toEqual({
        acme_vault: {
          upstream: "https://llm.acme.test/vault",
          credential_key: "cmd://acme_vault",
          inject_header: "X-Api-Key",
          credential_format: "{}",
          env_var: "ACME_VAULT_KEY"
        }
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
