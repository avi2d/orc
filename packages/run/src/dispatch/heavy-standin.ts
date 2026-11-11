import { Effect, FileSystem, Option } from "effect"
import { defaultHeavyTools } from "./heavy"
import { classifyArgv } from "./heavy-classify"
import {
  standinFinish,
  standinMarker,
  standinQueue,
  standinUtils,
  standinWait,
  type StandinTiming
} from "./heavy-standin-runtime"

export type { StandinTiming } from "./heavy-standin-runtime"

export type HeavyPlatform = "darwin" | "linux" | "other"

export interface StandinSettings {
  readonly home: string
  readonly group: string
  readonly wrap: string
  readonly through: ReadonlyArray<string> | null
}

export const detectWrap = (platform: HeavyPlatform, limit: "auto" | "none"): string => {
  if (limit === "none") {
    return ""
  }
  if (platform === "darwin") {
    return "taskpolicy -c utility"
  }
  return ""
}

export const standinTools = (commands: ReadonlyArray<string>): ReadonlyArray<string> => {
  const extra = commands.map((entry) => entry.trim().split(" ")[0] ?? "").filter((tool) => tool !== "")
  return [...new Set([...defaultHeavyTools, ...extra])]
}

const isExecutableFile = (fs: FileSystem.FileSystem, file: string): Effect.Effect<boolean> =>
  fs.stat(file).pipe(
    Effect.map((info) => info.type === "File" && (info.mode & 0o111) !== 0),
    Effect.orElseSucceed(() => false)
  )

const isStandinFile = (fs: FileSystem.FileSystem, file: string): Effect.Effect<boolean> =>
  Effect.scoped(
    fs.open(file).pipe(
      Effect.flatMap((handle) => handle.readAlloc(2048)),
      Effect.map((option) =>
        Option.match(option, {
          onNone: () => false,
          onSome: (bytes) => new TextDecoder().decode(bytes).includes(standinMarker)
        })
      ),
      Effect.orElseSucceed(() => false)
    )
  )

const findRealTool = (tool: string, pathValue: string): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    if (tool.includes("/") || tool === "" || tool === "." || tool === "..") {
      return ""
    }
    const fs = yield* FileSystem.FileSystem
    for (const entry of pathValue.split(":")) {
      if (!entry.startsWith("/")) {
        continue
      }
      const candidate = entry === "/" ? "/" + tool : entry + "/" + tool
      if (!(yield* isExecutableFile(fs, candidate))) {
        continue
      }
      if (yield* isStandinFile(fs, candidate)) {
        continue
      }
      return candidate
    }
    return ""
  })

const quoteSingle = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"

const standinHead = (tool: string, settings: StandinSettings, real: string): ReadonlyArray<string> => [
  '#!/bin/sh',
  '# ' + standinMarker + '. Regenerated on every run of that command.',
  'heavy_tool="' + tool + '"',
  'heavy_real=' + quoteSingle(real),
  'heavy_home="' + settings.home + '"',
  'heavy_group="' + settings.group + '"',
  'heavy_wrap="' + settings.wrap + '"'
]

// Bun would otherwise load the caller's .env and bunfig.toml preloads into the stand-in.
const classifyCall = (tool: string, commands: ReadonlyArray<string>): string =>
  [process.execPath, "--no-env-file", "--config=/dev/null", import.meta.dir + "/heavy-standin-main.ts", ...classifyArgv({ tool, commands })]
    .map(quoteSingle)
    .join(" ")

const standinDecideFn = (tool: string, commands: ReadonlyArray<string>): ReadonlyArray<string> => [
  'heavy_decide() {',
  '  heavy_decision="$(' + classifyCall(tool, commands) + ' "$@")" || {',
  '    echo "orc heavy: cannot classify the $heavy_tool call; rerun orc to rewrite the stand-in" >&2',
  '    exit 1',
  '  }',
  '  heavy_queue="${heavy_decision% *}"; heavy_prio="${heavy_decision#* }"',
  '}'
]

export const standinScript = (tool: string, settings: StandinSettings, commands: ReadonlyArray<string>, timing?: StandinTiming): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const resolved = yield* findRealTool(tool, Bun.env.PATH ?? "")
    return [
      ...standinHead(tool, settings, resolved),
      ...standinDecideFn(tool, commands),
      ...standinUtils(),
      ...standinQueue(settings.through),
      ...standinWait(timing),
      ...standinFinish()
    ].join("\n") + "\n"
  })

export const standinScripts = (
  settings: StandinSettings,
  commands: ReadonlyArray<string>,
  tools: ReadonlyArray<string> = standinTools(commands),
  timing?: StandinTiming
): Effect.Effect<Record<string, string>, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const entries: Array<[string, string]> = []
    for (const tool of tools) {
      entries.push([tool, yield* standinScript(tool, settings, commands, timing)])
    }
    return Object.fromEntries(entries)
  })
