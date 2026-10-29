import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Result } from "effect"
import { checkedModelWindows } from "../../packages/run/src/context-mark"
import { buildAgentNonoProfile, buildNonoProfile, defaultToolchainFolders, loginCheckCommand, modelCredentialFor, piAgentModels, providerKeyOf } from "../../packages/run/src/nono-profile"

const credential = {
  provider: "acme-go",
  name: "acme_go",
  upstream: "https://llm.acme.test/v1",
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

