import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path, Result } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { checkedModelWindows } from "../../packages/run/src/context-mark"
import { routeOfAgents } from "../../packages/run/src/model-route"
import { buildAgentNonoProfile, buildNonoProfile, defaultToolchainFolders, loginCheckCommand, modelCredentialFor, piAgentModels, providerKeyOf } from "../../packages/run/src/nono-profile"
import { readOrcConfig } from "../../packages/run/src/orc-config"
import { planSandbox } from "../../packages/run/src/sandbox-plan"

const credential = {
  provider: "acme-go",
  name: "acme_go",
  upstream: "https://llm.acme.test/v1",
  injectHeader: "Authorization",
  credentialFormat: "Bearer {}",
  envVar: "ACME_GO_KEY",
  captureCommand: ["/bin/sh", "-c", "HOME=\"$2\" PATH=\"$(dirname \"$0\"):$PATH\" unset PI_CODING_AGENT_DIR; exec \"$1\" auth print-api-key --provider \"$3\"", "/host/bin/node", "/host/bin/pi", "/host/home", "acme-go"]
}

const tools = { piBinary: "/host/bin/pi", nodeBinary: "/host/bin/node", homeDir: "/host/home" }

const roots = {
  worktree: "/work/tree",
  gitData: "/work/tree.git",
  piSessionDir: "/sessions",
  taskTmp: "/work/tree/.orc/tmp"
}

const host = { developerDir: "/dev/dir", toolchainFolders: defaultToolchainFolders, runtimeDirs: ["/run/bin"] }

describe("modelCredentialFor", () => {
  test("routes the configured provider to its upstream with a key name derived from its id", () => {
    expect(modelCredentialFor({ id: "acme-go", upstream: "https://llm.acme.test/v1" }, tools)).toEqual(credential)
  })
  test("passes the provider id as an argument so an id never becomes shell text", () => {
    const capture = modelCredentialFor({ id: "acme.go", upstream: "https://llm.acme.test/v1" }, tools).captureCommand
    expect(capture[2]).not.toContain("acme")
    expect(capture.at(-1)).toBe("acme.go")
  })
})

describe("loginCheckCommand", () => {
  test("checks the operator login without printing the credential", () => {
    expect(loginCheckCommand(tools, "acme-go")).toEqual([
      "/bin/sh",
      "-c",
      "HOME=\"$2\" PATH=\"$(dirname \"$0\"):$PATH\" unset PI_CODING_AGENT_DIR; exec \"$1\" auth check --provider \"$3\"",
      "/host/bin/node",
      "/host/bin/pi",
      "/host/home",
      "acme-go"
    ])
  })
  test("shapes the shell exactly like the capture so the check answers for the same login", () => {
    const check = loginCheckCommand(tools, "acme-go").slice(0, 3).join(" ")
    const capture = ["/bin/sh", "-c", credential.captureCommand[2]].join(" ")
    expect(check.split(";")[0]).toBe(capture.split(";")[0])
  })
})

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

describe("piAgentModels", () => {
  test("points the provider at the injected credential variable", () => {
    const parsed: unknown = JSON.parse(piAgentModels(providerKeyOf(credential), []))
    expect(parsed).toEqual({ providers: { "acme-go": { apiKey: "$ACME_GO_KEY" } } })
  })
  test("pins each agent window where the sandbox resolves it rather than leaving the built-in window", () => {
    const checked = Result.getOrThrow(checkedModelWindows(
      ["acme-go/coder-1"],
      new Map([["acme-go/coder-1", 262_144]])
    ))
    const parsed: unknown = JSON.parse(piAgentModels(providerKeyOf(credential), checked))
    expect(parsed).toEqual({ providers: { "acme-go": { apiKey: "$ACME_GO_KEY", modelOverrides: { "coder-1": { contextWindow: 262_144 } } } } })
  })
})

describe("buildAgentNonoProfile", () => {
  test("keeps the base mounts and adds the credential route with its capture", async () => {
    const base = await Effect.runPromise(buildNonoProfile(roots, host).pipe(Effect.provide(BunServices.layer)))
    const profile = await Effect.runPromise(buildAgentNonoProfile(roots, host, credential).pipe(Effect.provide(BunServices.layer)))
    expect(profile.filesystem).toEqual(base.filesystem)
    expect(profile.network.allow_domain).toEqual(base.network.allow_domain)
    expect(profile.network.credentials).toEqual(["acme_go"])
    expect(profile.network.custom_credentials).toEqual({
      acme_go: {
        upstream: "https://llm.acme.test/v1",
        credential_key: "cmd://acme_go",
        inject_header: "Authorization",
        credential_format: "Bearer {}",
        env_var: "ACME_GO_KEY"
      }
    })
    expect(profile.credential_capture).toEqual({
      acme_go: {
        command: credential.captureCommand,
        timeout_secs: 15,
        cache_ttl_secs: 900
      }
    })
  })
})

