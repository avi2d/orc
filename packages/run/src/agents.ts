import { Data, Effect, FileSystem, Path } from "effect"
import type { PlatformError } from "effect/PlatformError"

export class AgentFileError extends Data.TaggedError("AgentFileError")<{
  readonly message: string
}> {}

export type AgentKind = "implementer" | "fixer"

type AgentSource = "personal" | "project" | "bundled"

const piThinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const

type PiThinkingLevel = typeof piThinkingLevels[number]

export interface AgentFile {
  readonly kind: AgentKind
  readonly model: string
  readonly thinking: PiThinkingLevel
  readonly tools: ReadonlyArray<string>
  readonly body: string
  readonly path: string
  readonly source: AgentSource
}

export interface AgentFileLocation {
  readonly kind: AgentKind
  readonly path: string
  readonly source: AgentSource
}

const headerKeys = ["model", "thinking", "tools"] as const

type HeaderKey = typeof headerKeys[number]

const requiredHeaderKeys: ReadonlyArray<HeaderKey> = ["thinking", "tools"]

export interface ParsedAgentFile extends Omit<AgentFile, "model"> {
  readonly model: string | null
}

const isHeaderKey = (key: string): key is HeaderKey => (headerKeys as ReadonlyArray<string>).includes(key)

const isThinkingLevel = (value: string): value is PiThinkingLevel =>
  (piThinkingLevels as ReadonlyArray<string>).includes(value)

const fail = (path: string, detail: string): Effect.Effect<never, AgentFileError> =>
  Effect.fail(new AgentFileError({ message: "orc: the agent file " + path + " " + detail }))

const parseHeader = (
  lines: ReadonlyArray<string>,
  closing: number,
  path: string
): Effect.Effect<Map<string, string>, AgentFileError> =>
  Effect.gen(function*() {
    const seen = new Map<string, string>()
    for (const line of lines.slice(1, closing)) {
      if (line.trim() === "") {
        continue
      }
      const colon = line.indexOf(":")
      if (colon === -1) {
        return yield* fail(path, "holds a header line without a colon: " + line)
      }
      const key = line.slice(0, colon).trim()
      const value = line.slice(colon + 1).trim()
      if (!isHeaderKey(key)) {
        return yield* fail(path, "names an unknown header key: " + key)
      }
      if (seen.has(key)) {
        return yield* fail(path, "names the header key " + key + " twice")
      }
      seen.set(key, value)
    }
    for (const key of requiredHeaderKeys) {
      if (!seen.has(key)) {
        return yield* fail(path, "misses the header key " + key)
      }
    }
    return seen
  })

const checkFields = (
  seen: ReadonlyMap<string, string>,
  path: string
): Effect.Effect<{ readonly model: string | null; readonly thinking: PiThinkingLevel; readonly tools: ReadonlyArray<string> }, AgentFileError> =>
  Effect.gen(function*() {
    const model = seen.get("model") ?? null
    if (model !== null && (model === "" || /\s/.test(model))) {
      return yield* fail(path, "names no usable model")
    }
    const thinking = seen.get("thinking") ?? ""
    if (!isThinkingLevel(thinking)) {
      return yield* fail(path, "names an unknown thinking level: " + thinking)
    }
    const tools = (seen.get("tools") ?? "").split(",").map((tool) => tool.trim()).filter((tool) => tool !== "")
    if (tools.length === 0) {
      return yield* fail(path, "names no tools")
    }
    return { model, thinking, tools }
  })

export const parseAgentFile = (
  text: string,
  location: AgentFileLocation
): Effect.Effect<ParsedAgentFile, AgentFileError> =>
  Effect.gen(function*() {
    const lines = text.split("\n")
    if (lines[0] !== "---") {
      return yield* fail(location.path, "starts without a --- header line")
    }
    const closing = lines.indexOf("---", 1)
    if (closing === -1) {
      return yield* fail(location.path, "never closes its --- header")
    }
    const seen = yield* parseHeader(lines, closing, location.path)
    const fields = yield* checkFields(seen, location.path)
    const body = lines.slice(closing + 1).join("\n").trim()
    if (body === "") {
      return yield* fail(location.path, "holds no instructions below its header")
    }
    return { kind: location.kind, model: fields.model, thinking: fields.thinking, tools: fields.tools, body, path: location.path, source: location.source }
  })
const readIfPresent = (
  fs: FileSystem.FileSystem,
  path: string
): Effect.Effect<string | null, AgentFileError> =>
  fs.readFileString(path).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed<string | null>(null)),
    Effect.mapError(
      (cause: PlatformError) => new AgentFileError({ message: "orc: cannot read the agent file " + path + ": " + cause.message })
    )
  )

export const bundledAgentsDir = (): string => import.meta.dir + "/../agents"

export const agentFileCandidates = (
  path: Path.Path,
  kind: AgentKind,
  projectDir: string,
  orcHome: string,
  agentsDir: string = bundledAgentsDir()
): ReadonlyArray<AgentFileLocation> => [
  { kind, path: path.join(orcHome, "agents", kind + ".md"), source: "personal" },
  { kind, path: path.join(projectDir, ".orc", "agents", kind + ".md"), source: "project" },
  { kind, path: path.join(agentsDir, kind + ".md"), source: "bundled" }
]

export const resolveAgentFile = (
  kind: AgentKind,
  options: {
    readonly projectDir: string
    readonly orcHome: string
    readonly agentsDir?: string | undefined
    readonly configModel: { readonly file: string; readonly model: string | undefined }
  }
): Effect.Effect<AgentFile, AgentFileError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const candidates = agentFileCandidates(path, kind, options.projectDir, options.orcHome, options.agentsDir)
    for (const location of candidates) {
      const text = yield* readIfPresent(fs, location.path)
      if (text !== null) {
        const parsed = yield* parseAgentFile(text, location)
        const model = parsed.model ?? options.configModel.model
        if (model === undefined) {
          return yield* fail(location.path, "names no model and " + options.configModel.file + " names no " + kind + " model, so name one in either")
        }
        return { ...parsed, model }
      }
    }
    return yield* new AgentFileError({ message: "orc: no " + kind + ".md agent file found beside the bundled ones" })
  })

