import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { buildAgentNonoProfile, buildNonoProfile, canRouteModel, defaultToolchainFolders, loginCheckCommand, modelCredentialFor, piAgentModels } from "../../packages/run/src/nono-profile"

const credential = {
  provider: "opencode-go",
  name: "opencode_go",
  upstream: "https://opencode.ai/zen/go/v1",
  envVar: "OPENCODE_GO_KEY",
  captureCommand: ["/bin/sh", "-c", "HOME=\"$2\" PATH=\"$(dirname \"$0\"):$PATH\" unset PI_CODING_AGENT_DIR; exec \"$1\" auth print-api-key --provider opencode-go", "/host/bin/node", "/host/bin/pi", "/host/home"]
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
  test("routes opencode-go models to the zen proxy credential", () => {
    expect(modelCredentialFor("opencode-go/muse-spark", tools)).toEqual(credential)
  })
  test("refuses models from other providers", () => {
    expect(modelCredentialFor("anthropic/claude", tools)).toBeNull()
    expect(modelCredentialFor("local-model", tools)).toBeNull()
  })
})

describe("canRouteModel", () => {
  test("routes only opencode-go models", () => {
    expect(canRouteModel("opencode-go/muse-spark")).toBe(true)
    expect(canRouteModel("anthropic/claude")).toBe(false)
    expect(canRouteModel("local-model")).toBe(false)
  })
})

describe("loginCheckCommand", () => {
  test("checks the operator login without printing the credential", () => {
    expect(loginCheckCommand(tools)).toEqual([
      "/bin/sh",
      "-c",
      "HOME=\"$2\" PATH=\"$(dirname \"$0\"):$PATH\" unset PI_CODING_AGENT_DIR; exec \"$1\" auth check --provider opencode-go",
      "/host/bin/node",
      "/host/bin/pi",
      "/host/home"
    ])
  })
  test("shapes the shell exactly like the capture so the check answers for the same login", () => {
    const check = loginCheckCommand(tools).slice(0, 3).join(" ")
    const capture = ["/bin/sh", "-c", credential.captureCommand[2]].join(" ")
    expect(check.split(";")[0]).toBe(capture.split(";")[0])
  })
})

describe("piAgentModels", () => {
  test("points the provider at the injected credential variable", () => {
    const parsed: unknown = JSON.parse(piAgentModels(credential, [], new Map()))
    expect(parsed).toEqual({ providers: { "opencode-go": { apiKey: "$OPENCODE_GO_KEY" } } })
  })
  test("pins each agent window where the sandbox resolves it rather than leaving the built-in window", () => {
    const parsed: unknown = JSON.parse(piAgentModels(credential, ["opencode-go/muse-spark-1.3-contributor"], new Map([["opencode-go/muse-spark-1.3-contributor", 262_144]])))
    expect(parsed).toEqual({ providers: { "opencode-go": { apiKey: "$OPENCODE_GO_KEY", modelOverrides: { "muse-spark-1.3-contributor": { contextWindow: 262_144 } } } } })
  })
})

describe("buildAgentNonoProfile", () => {
  test("keeps the base mounts and adds the credential route with its capture", async () => {
    const base = await Effect.runPromise(buildNonoProfile(roots, host).pipe(Effect.provide(BunServices.layer)))
    const profile = await Effect.runPromise(buildAgentNonoProfile(roots, host, credential).pipe(Effect.provide(BunServices.layer)))
    expect(profile.filesystem).toEqual(base.filesystem)
    expect(profile.network.allow_domain).toEqual(base.network.allow_domain)
    expect(profile.network.credentials).toEqual(["opencode_go"])
    expect(profile.network.custom_credentials).toEqual({
      opencode_go: {
        upstream: "https://opencode.ai/zen/go/v1",
        credential_key: "cmd://opencode_go",
        inject_header: "Authorization",
        credential_format: "Bearer {}",
        env_var: "OPENCODE_GO_KEY"
      }
    })
    expect(profile.credential_capture).toEqual({
      opencode_go: {
        command: credential.captureCommand,
        timeout_secs: 15,
        cache_ttl_secs: 900
      }
    })
  })
})

