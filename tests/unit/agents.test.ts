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
  "model: opencode-go/muse-spark",
  "thinking: high",
  "tools: read, bash, edit",
  "---",
  "Do the task.",
  "",
].join("\n")

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
      model: "opencode-go/muse-spark",
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

  test("refuses an unusable model, an unknown thinking level and no tools", () => {
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
      await writeAgent(join(home, "agents"), "implementer.md", good.replace("muse-spark", "personal-model"))
      await writeAgent(join(project, ".orc", "agents"), "implementer.md", good.replace("muse-spark", "project-model"))
      await writeAgent(bundled, "implementer.md")
      const found = await Effect.runPromise(
        resolveAgentFile("implementer", { projectDir: project, orcHome: home, agentsDir: bundled }).pipe(
          Effect.provide(BunServices.layer)
        )
      )
      expect(found.source).toBe("personal")
      expect(found.model).toBe("opencode-go/personal-model")
    })
  })

  test("the project file wins over the bundled file", async () => {
    await withDirs(async (root) => {
      const home = join(root, "orc-home")
      const project = join(root, "project")
      const bundled = join(root, "bundled")
      await writeAgent(join(project, ".orc", "agents"), "implementer.md")
      await writeAgent(bundled, "implementer.md", good.replace("muse-spark", "bundled-model"))
      const found = await Effect.runPromise(
        resolveAgentFile("implementer", { projectDir: project, orcHome: home, agentsDir: bundled }).pipe(
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
        resolveAgentFile("implementer", { projectDir: project, orcHome: root, agentsDir: bundled }).pipe(
          Effect.provide(BunServices.layer),
          Effect.catchTag("AgentFileError", (cause) => Effect.succeed("refused: " + cause.message))
        )
      )
      expect(result).toContain("starts without a --- header line")
    })
  })

  test("the bundled implementer and fixer files parse with the expected header", async () => {
    for (const kind of ["implementer", "fixer"] as const) {
      const found = await Effect.runPromise(
        resolveAgentFile(kind, { projectDir: tmpdir(), orcHome: tmpdir() }).pipe(Effect.provide(BunServices.layer))
      )
      expect(found.source).toBe("bundled")
      expect(found.path).toBe(join(bundledAgentsDir(), kind + ".md"))
      expect(found.thinking).toBe("high")
      expect(found.tools).toEqual(["read", "bash", "edit", "write"])
      expect(found.model.length).toBeGreaterThan(0)
    }
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

