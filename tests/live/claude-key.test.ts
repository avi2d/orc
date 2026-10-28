import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { skipReason } from "@avi2dg/checks/scripts/test-skips.ts"
import { Schema } from "effect"
import { claudeApiKey, claudeProvider, claudeTokenFileVar } from "../../packages/run/src/model-route"
import { piAgentModels } from "../../packages/run/src/nono-profile"

const noPi = Bun.which("pi") === null

const token = "sk-ant-oat01-orc-live-fixture-token"

const decodeClaudeModels = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ providers: Schema.Struct({ anthropic: Schema.Struct({ apiKey: Schema.String }) }) })))

const runPiAgainst = async (agentDir: string, cwd: string, env: Record<string, string>): Promise<ReadonlyArray<string | null>> => {
  const authHeaders: Array<string | null> = []
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      authHeaders.push(request.headers.get("authorization") ?? request.headers.get("x-api-key"))
      return Response.json({ type: "error", error: { type: "authentication_error", message: "fixture" } }, { status: 401 })
    }
  })
  try {
    const written = decodeClaudeModels(piAgentModels({ provider: claudeProvider, apiKey: claudeApiKey }, []))
    const baseUrl = "http://127.0.0.1:" + server.port
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { anthropic: { ...written.providers.anthropic, baseUrl } } }))
    const pi = Bun.spawn(["pi", "--model", claudeProvider + "/claude-sonnet-4-5", "-p", "--no-session", "Say hi."], { cwd, env, stdout: "ignore", stderr: "ignore" })
    await pi.exited
    return authHeaders
  } finally {
    await server.stop(true)
  }
}

describe("Pi on the Claude agent folder orc writes", () => {
  test.skipIf(noPi)(skipReason("needs pi on PATH", "sends the token file's text without its newline, not an operator ANTHROPIC variable"), async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "orc-claude-key-")))
    try {
      const agentDir = join(root, "agent")
      await mkdir(agentDir)
      const tokenFile = join(root, "token")
      await writeFile(tokenFile, token + "\n")
      await chmod(tokenFile, 0o600)
      const env: Record<string, string> = {
        PATH: process.env["PATH"] ?? "",
        HOME: root,
        PI_CODING_AGENT_DIR: agentDir,
        [claudeTokenFileVar]: tokenFile,
        ANTHROPIC_API_KEY: "sk-ant-api03-operator-variable",
        ANTHROPIC_AUTH_TOKEN: "operator-auth-token",
        ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat01-operator-variable"
      }
      expect(await runPiAgainst(agentDir, root, env)).toEqual(["Bearer " + token])
      expect(await Bun.file(join(agentDir, "auth.json")).text()).not.toContain(token)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
