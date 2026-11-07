import { describe, expect, test } from "bun:test"
import { ChildProcess } from "effect/process"
import { agentCommand, agentEnv, nonoRunArgs, pickEnv } from "../../packages/run/src/agent-exec"

describe("agentEnv", () => {
  test("drops every ORC_ variable, so orc commands the agent runs never reach the operator's home", () => {
    const env = agentEnv({ PATH: "/bin", ORC_HOME: "/home/op/.orc" }, { ORC_TOOLCHAIN_DIRS: "/opt", AGENT_TOKEN_FILE: "/k" })
    expect(Object.keys(env).filter((name) => name.startsWith("ORC_"))).toEqual([])
    expect(env.AGENT_TOKEN_FILE).toBe("/k")
  })

  test("turns off bun's auto-install even when the caller asks for it, so a copy without node_modules fails loud", () => {
    expect(agentEnv({ BUN_OPTIONS: "" }, { BUN_OPTIONS: "--smol" }).BUN_OPTIONS).toBe("--no-install")
  })
})

describe("pickEnv", () => {
  test("carries only the named variables that are set, not the rest of the host env", () => {
    expect(pickEnv({ PATH: "/bin", HOME: undefined, SSH_AUTH_SOCK: "/s" }, ["PATH", "HOME"])).toEqual({ PATH: "/bin" })
  })
})

describe("agentCommand", () => {
  test("a nono exec runs the argv under nono with the profile instead of on the host", () => {
    const argv = ["pi", "-p", "a b"] as const
    expect(nonoRunArgs("/p.json", argv)).toEqual(["run", "--silent", "--profile", "/p.json", "--", "pi", "-p", "a b"])
    const command = agentCommand({ kind: "nono", cwd: "/w", env: {}, nonoBinary: "/bin/nono", profilePath: "/p.json" }, argv)
    expect(ChildProcess.isStandardCommand(command) ? [command.command, ...command.args] : []).toEqual(["/bin/nono", "run", "--silent", "--profile", "/p.json", "--", "pi", "-p", "a b"])
  })

  test("a host exec runs the argv itself with only the env it names", () => {
    const command = agentCommand({ kind: "none", cwd: "/w", env: { PATH: "/bin" } }, ["sh", "-c", "true"])
    expect(ChildProcess.isStandardCommand(command) ? { argv: [command.command, ...command.args], cwd: command.options.cwd, env: command.options.env, extendEnv: command.options.extendEnv } : null)
      .toEqual({ argv: ["sh", "-c", "true"], cwd: "/w", env: { PATH: "/bin" }, extendEnv: false })
  })
})
