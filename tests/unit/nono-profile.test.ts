import { describe, expect, test } from "bun:test"
import { buildAgentNonoProfile, buildNonoProfile, canRouteModel, loginCheckCommand, modelCredentialFor, piAgentModels } from "../../src/nono-profile"

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

const host = { developerDir: "/dev/dir", runtimeDirs: ["/run/bin"] }

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
    const parsed: unknown = JSON.parse(piAgentModels(credential))
    expect(parsed).toEqual({ providers: { "opencode-go": { apiKey: "$OPENCODE_GO_KEY" } } })
  })
})

describe("buildAgentNonoProfile", () => {
  test("keeps the base mounts and adds the credential route with its capture", () => {
    const base = buildNonoProfile(roots, host)
    const profile = buildAgentNonoProfile(roots, host, credential)
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


describe("runtimeReadFiles", () => {
  test("leaves out the system bundle macOS seals off from the sandbox", () => {
    const readFiles = buildNonoProfile(roots, host).filesystem.read_file
    if (process.platform === "darwin") {
      expect(readFiles).not.toContain("/etc/ssl/cert.pem")
    } else {
      expect(readFiles).toContain("/etc/ssl/cert.pem")
    }
    expect(readFiles).toContain("/etc/ssl/openssl.cnf")
  })
})
