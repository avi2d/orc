import { Effect, FileSystem, Option } from "effect"
import { defaultHeavyTools } from "./heavy"
import { standinMarker, type StandinCall, type StandinTiming } from "./heavy-standin-runtime"

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

const standinHead = (tool: string, settings: StandinSettings, commands: ReadonlyArray<string>, real: string, timing?: StandinTiming): ReadonlyArray<string> => {
  const call: StandinCall = {
    tool, commands, home: settings.home, group: settings.group, wrap: settings.wrap, real, through: settings.through, timing: timing ?? null
  }
  return [
    '#!/bin/sh',
    '# ' + standinMarker + '. Regenerated on every run of that command.',
    'heavy_tool="' + tool + '"',
    'heavy_real=' + quoteSingle(real),
    'heavy_bun=' + quoteSingle(process.execPath),
    'heavy_main=' + quoteSingle(Bun.fileURLToPath(import.meta.resolve("./heavy-standin-main.ts"))),
    'heavy_wrap="' + settings.wrap + '"',
    'heavy_call=' + quoteSingle(JSON.stringify(call))
  ]
}

// Bun would otherwise load the caller's .env and bunfig.toml preloads into the stand-in.
const helper = '"$heavy_bun" --no-env-file --config=/dev/null "$heavy_main"'

const standinDecideFn: ReadonlyArray<string> = [
  'heavy_ready() {',
  '  if [ ! -x "$heavy_bun" ]; then',
  '    echo "orc heavy: no bun at $heavy_bun; rerun orc to rewrite the stand-ins" >&2',
  '    return 1',
  '  fi',
  '  if [ ! -f "$heavy_main" ]; then',
  '    echo "orc heavy: no stand-in helper at $heavy_main; rerun orc to rewrite the stand-ins" >&2',
  '    return 1',
  '  fi',
  '}',
  '',
  'if [ -n "$HEAVY_CLASSIFY" ]; then',
  '  heavy_ready || exit 1',
  '  ' + helper + ' classify "$heavy_call" "$@" || {',
  '    echo "orc heavy: cannot classify the $heavy_tool call with $heavy_bun; rerun orc to rewrite the stand-ins" >&2',
  '    exit 1',
  '  }',
  '  exit 0',
  'fi'
]

const throughExec = (through: ReadonlyArray<string> | null): ReadonlyArray<string> =>
  through === null
    ? []
    : ['    "through "*) exec sh -c \'"$@"; exit "$?"\' orc-heavy-through ' + through.map(quoteSingle).join(" ") + ' $heavy_wrap "${heavy_plan#through }" "$@";;']

const standinLaunch = (through: ReadonlyArray<string> | null): ReadonlyArray<string> => [
  'if heavy_ready; then',
  '  heavy_plan="$(' + helper + ' plan "$heavy_call" "$0" "$@")"',
  '  case "$heavy_plan" in',
  '    "run "*) exec "${heavy_plan#run }" "$@";;',
  '    "bypass "*) export HEAVY_QUEUE_BYPASSED="$HEAVY_QUEUE_BYPASS"; exec "${heavy_plan#bypass }" "$@";;',
  ...throughExec(through),
  '    "queue "*) exec ' + helper + ' queue "$heavy_call" "${heavy_plan#queue }" "$@";;',
  '    "exit "*) exit "${heavy_plan#exit }";;',
  '  esac',
  '  echo "orc heavy: cannot classify the $heavy_tool call with $heavy_bun; rerun orc to rewrite the stand-ins" >&2',
  'fi',
  'if [ -z "$heavy_real" ] || [ ! -x "$heavy_real" ] || [ -d "$heavy_real" ]; then',
  '  echo "orc heavy: no $heavy_tool at $heavy_real" >&2',
  '  exit 127',
  'fi',
  'exec "$heavy_real" "$@"',
  ''
]

export const standinScript = (tool: string, settings: StandinSettings, commands: ReadonlyArray<string>, timing?: StandinTiming): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const resolved = yield* findRealTool(tool, Bun.env.PATH ?? "")
    return [...standinHead(tool, settings, commands, resolved, timing), ...standinDecideFn, ...standinLaunch(settings.through)].join("\n")
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
