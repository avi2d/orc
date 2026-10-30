import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Path } from "effect"
import {
  agentFileCandidates,
  bundledAgentsDir,
  parseAgentFile,
  resolveAgentFile,
} from "../../packages/run/src/agents"

const good = [
  "---",
  "model: acme/coder",
  "thinking: high",
  "tools: read, bash, edit",
  "---",
  "Do the task.",
  "",
].join("\n")

const noConfigModel = { file: "/orc-home/config.json", model: undefined }

const resolved = (kind: "implementer" | "fixer", options: Parameters<typeof resolveAgentFile>[1]) =>
  Effect.runPromise(resolveAgentFile(kind, options).pipe(
    Effect.provide(BunServices.layer),
    Effect.catchTag("AgentFileError", (cause) => Effect.succeed("refused: " + cause.message))
  ))

const location = { kind: "implementer" as const, path: "bundled/implementer.md", source: "bundled" as const }

const parsed = (text: string) => Effect.runSync(parseAgentFile(text, location))

const failure = (text: string): string => {
  try {
    parsed(text)
    throw new Error("the malformed agent file parsed")
  } catch (cause) {
    return String(cause)
  }
}

const withDirs = async (use: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-agents-"))
  try {
    await use(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const writeAgent = (dir: string, name: string, text: string = good): Promise<void> =>
  mkdir(dir, { recursive: true }).then(() => writeFile(join(dir, name), text))

describe("parseAgentFile", () => {
  test("reads the model, the thinking level, the tools and the body", () => {
    expect(parsed(good)).toMatchObject({
      kind: "implementer",
      model: "acme/coder",
      thinking: "high",
      tools: ["read", "bash", "edit"],
      body: "Do the task.",
    })
  })

  test("tolerates blank header lines and spaced tool names", () => {
    const text = ["---", "", "model:  m  ", "thinking: low", "tools: read ,bash", "---", "Go."].join("\n")
    expect(parsed(text)).toMatchObject({ model: "m", thinking: "low", tools: ["read", "bash"], body: "Go." })
  })

  test("refuses a file without a header, with an open header and with no body", () => {
    expect(failure("Do the task.\n")).toContain("starts without a --- header line")
    expect(failure("---\nmodel: m\n")).toContain("never closes its --- header")
    expect(failure("---\nmodel: m\nthinking: high\ntools: read\n---\n  \n")).toContain("holds no instructions")
  })

  test("refuses unknown, doubled and missing header keys", () => {
    expect(failure(["---", "model: m", "thinking: high", "tools: read", "voice: loud", "---", "Go."].join("\n"))).toContain("unknown header key: voice")
    expect(failure(["---", "model: m", "thinking: high", "tools: read", "tools: bash", "---", "Go."].join("\n"))).toContain("names the header key tools twice")
    expect(failure(["---", "model: m", "thinking: high", "---", "Go."].join("\n"))).toContain("misses the header key tools")
    expect(failure(["---", "model m", "thinking: high", "tools: read", "---", "Go."].join("\n"))).toContain("without a colon")
  })

  test("leaves the model unnamed when the header omits it instead of refusing the file", () => {
    expect(parsed(["---", "thinking: high", "tools: read", "---", "Go."].join("\n")).model).toBeNull()
  })

  test("refuses an unusable model, an unknown thinking level and no tools", () => {
    expect(failure(["---", "model:", "thinking: high", "tools: read", "---", "Go."].join("\n"))).toContain("no usable model")
    expect(failure(["---", "model: two words", "thinking: high", "tools: read", "---", "Go."].join("\n"))).toContain("no usable model")
    expect(failure(["---", "model: m", "thinking: extreme", "tools: read", "---", "Go."].join("\n"))).toContain("unknown thinking level: extreme")
    expect(failure(["---", "model: m", "thinking: high", "tools:  , ", "---", "Go."].join("\n"))).toContain("names no tools")
  })
})

describe("resolveAgentFile", () => {
  test("the personal file wins over the project file and the bundled file", async () => {
    await withDirs(async (root) => {
      const home = join(root, "orc-home")
      const project = join(root, "project")
      const bundled = join(root, "bundled")
      await writeAgent(join(home, "agents"), "implementer.md", good.replace("coder", "personal-model"))
      await writeAgent(join(project, ".orc", "agents"), "implementer.md", good.replace("coder", "project-model"))
      await writeAgent(bundled, "implementer.md")
      const found = await Effect.runPromise(
        resolveAgentFile("implementer", { projectDir: project, orcHome: home, agentsDir: bundled, configModel: noConfigModel }).pipe(
          Effect.provide(BunServices.layer)
        )
      )
      expect(found.source).toBe("personal")
      expect(found.model).toBe("acme/personal-model")
    })
  })

  test("the project file wins over the bundled file", async () => {
    await withDirs(async (root) => {
      const home = join(root, "orc-home")
      const project = join(root, "project")
      const bundled = join(root, "bundled")
      await writeAgent(join(project, ".orc", "agents"), "implementer.md")
      await writeAgent(bundled, "implementer.md", good.replace("coder", "bundled-model"))
      const found = await Effect.runPromise(
        resolveAgentFile("implementer", { projectDir: project, orcHome: home, agentsDir: bundled, configModel: noConfigModel }).pipe(
          Effect.provide(BunServices.layer)
        )
      )
      expect(found.source).toBe("project")
      expect(found.body).toBe("Do the task.")
    })
  })

  test("a broken higher-precedence file fails instead of falling back", async () => {
    await withDirs(async (root) => {
      const project = join(root, "project")
      const bundled = join(root, "bundled")
      await writeAgent(join(project, ".orc", "agents"), "implementer.md", "no header here\n")
      await writeAgent(bundled, "implementer.md")
      const result = await Effect.runPromise(
        resolveAgentFile("implementer", { projectDir: project, orcHome: root, agentsDir: bundled, configModel: noConfigModel }).pipe(
          Effect.provide(BunServices.layer),
          Effect.catchTag("AgentFileError", (cause) => Effect.succeed("refused: " + cause.message))
        )
      )
      expect(result).toContain("starts without a --- header line")
    })
  })

  test("the bundled implementer and fixer files name no model and take the one config.json names", async () => {
    for (const kind of ["implementer", "fixer"] as const) {
      const found = await resolved(kind, { projectDir: tmpdir(), orcHome: tmpdir(), configModel: { file: "/orc-home/config.json", model: "acme/configured" } })
      if (typeof found === "string") {
        throw new Error(found)
      }
      expect(found.source).toBe("bundled")
      expect(found.path).toBe(join(bundledAgentsDir(), kind + ".md"))
      expect(found.thinking).toBe("high")
      expect(found.tools).toEqual(["read", "bash", "edit", "write"])
      expect(found.model).toBe("acme/configured")
    }
  })

  test("the bundled files with no configured model are refused instead of running on a built-in model", async () => {
    for (const kind of ["implementer", "fixer"] as const) {
      expect(await resolved(kind, { projectDir: tmpdir(), orcHome: tmpdir(), configModel: noConfigModel })).toBe(
        "refused: orc: the agent file " + join(bundledAgentsDir(), kind + ".md") + " names no model and /orc-home/config.json names no " + kind + " model, so name one in either"
      )
    }
  })

  test("a model the agent file names wins over the configured one instead of being overridden by it", async () => {
    await withDirs(async (root) => {
      const project = join(root, "project")
      await writeAgent(join(project, ".orc", "agents"), "implementer.md")
      const found = await resolved("implementer", { projectDir: project, orcHome: root, agentsDir: join(root, "none"), configModel: { file: "/orc-home/config.json", model: "acme/configured" } })
      expect(typeof found === "string" ? found : found.model).toBe("acme/coder")
    })
  })

  test("candidates list personal, project then bundled in that order", async () => {
    const sources = await Effect.runPromise(
      Effect.gen(function*() {
        const path = yield* Path.Path
        return agentFileCandidates(path, "fixer", "/project", "/orc-home", "/bundled").map((candidate) => [candidate.source, candidate.path] as const)
      }).pipe(Effect.provide(BunServices.layer))
    )
    expect(sources).toEqual([
      ["personal", "/orc-home/agents/fixer.md"],
      ["project", "/project/.orc/agents/fixer.md"],
      ["bundled", "/bundled/fixer.md"],
    ])
  })
})

