import { Buffer } from "node:buffer"
import { closeSync, openSync, readSync, statSync } from "node:fs"
import { defaultHeavyTools } from "./heavy"
import { decideBody, extraSub } from "./heavy-standin-decide"
import {
  standinFinish,
  standinMarker,
  standinQueue,
  standinUtils,
  standinWait,
  type StandinTiming
} from "./heavy-standin-runtime"

export type { StandinTiming } from "./heavy-standin-runtime"

const helpers: ReadonlyArray<string> = [
  'heavy_version() {',
  '  for heavy_a in "$@"; do',
  '    case "$heavy_a" in --version|-v|--help|-h) return 0;; esac',
  '  done',
  '  return 1',
  '}',
  '',
  'heavy_watchflag() {',
  '  for heavy_a in "$@"; do',
  '    case "$heavy_a" in --watch|--watchAll|--watch-all|--interactive|--ui) return 0;; esac',
  '  done',
  '  return 1',
  '}',
  '',
  'heavy_valueflag() {',
  '  case "$1" in',
  '    --timeout|--reporter|--maxWorkers|--max-workers|--project|--config|--output|--outDir|--outdir|--manifest-path|--target|-p|-c|-o) return 0;;',
  '  esac',
  '  return 1',
  '}',
  '',
  'heavy_targeted() {',
  '  while [ $# -gt 0 ]; do',
  '    case "$1" in',
  '      --changed|-t|--test-name-pattern|-g|--grep|-k|-run) return 0;;',
  '      *.test.*|*.spec.*|*_test.go|test_*.py|*_test.py|*/test_*.py) return 0;;',
  '    esac',
  '    if heavy_valueflag "$1"; then shift; if [ $# -eq 0 ]; then break; fi; shift; if [ $# -eq 0 ]; then break; fi; continue; fi',
  '    case "$1" in',
  '      -*) ;;',
  '      ./...|.) ;;',
  '      */*) return 0;;',
  '    esac',
  '    shift',
  '  done',
  '  return 1',
  '}',
  '',
  'heavy_targeted_bare() {',
  '  while [ $# -gt 0 ]; do',
  '    case "$1" in',
  '      --changed|-t|--test-name-pattern|-g|--grep|-k|-run) return 0;;',
  '    esac',
  '    if heavy_valueflag "$1"; then shift; if [ $# -eq 0 ]; then break; fi; shift; if [ $# -eq 0 ]; then break; fi; continue; fi',
  '    case "$1" in',
  '      -*) ;;',
  '      ./...|.) ;;',
  '      *) return 0;;',
  '    esac',
  '    shift',
  '  done',
  '  return 1',
  '}',
  '',
  'heavy_exec_tool() {',
  '  case "$1" in -*) return;; esac',
  '  case "$1" in',
  '    checks-*)',
  '      shift; heavy_queue=1; if heavy_targeted "$@"; then heavy_prio=1; fi;;',
  '    vitest)',
  '      shift; case "${1:-}" in watch|dev) return;; esac',
  '      for heavy_a in "$@"; do case "$heavy_a" in -w) return;; esac; done',
  '      if [ "${1:-}" = "run" ]; then shift; fi',
  '      heavy_queue=1; if heavy_targeted_bare "$@"; then heavy_prio=1; fi;;',
  '    jest)',
  '      shift; heavy_queue=1; if heavy_targeted_bare "$@"; then heavy_prio=1; fi;;',
  '    tsc)',
  '      shift; for heavy_a in "$@"; do case "$heavy_a" in -w) return;; esac; done',
  '      heavy_queue=1; if heavy_targeted "$@"; then heavy_prio=1; fi;;',
  '    playwright|eslint|oxlint)',
  '      shift; heavy_queue=1; if heavy_targeted "$@"; then heavy_prio=1; fi;;',
  '  esac',
  '}',
  '',
  'heavy_run_script() {',
  '  while [ $# -gt 0 ]; do',
  '    case "$1" in',
  '      --filter|--cwd|-w|--workspace|--prefix) shift; if [ $# -eq 0 ]; then break; fi; shift; if [ $# -eq 0 ]; then break; fi;;',
  '      -*) shift;;',
  '      *) break;;',
  '    esac',
  '  done',
  '  case "${1:-}" in',
  '    ""|dev|start|serve|preview|watch|storybook|*:watch|*:ui|*:dev) return;;',
  '    test|tests|lint|typecheck|build|check|checks|e2e|coverage|mutation|checks-*|test:*|build:*|lint:*|typecheck:*|vitest|jest|tsc|eslint|oxlint|playwright)',
  '      shift; if heavy_watchflag "$@"; then return; fi',
  '      heavy_queue=1; if heavy_targeted "$@"; then heavy_prio=1; fi;;',
  '  esac',
  '}'
]

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

const isExecutableFile = (file: string): boolean => {
  try {
    const info = statSync(file)
    if (!info.isFile()) {
      return false
    }
    return (info.mode & 0o111) !== 0
  } catch {
    return false
  }
}

const isStandinFile = (file: string): boolean => {
  let handle = -1
  try {
    handle = openSync(file, "r")
  } catch {
    return false
  }
  try {
    const area = Buffer.alloc(2048)
    const count = readSync(handle, area, 0, 2048, 0)
    return area.toString("utf8", 0, count).includes(standinMarker)
  } catch {
    return false
  } finally {
    try {
      closeSync(handle)
    } catch {
      handle = -1
    }
  }
}

export const findRealTool = (tool: string, pathValue: string): string => {
  if (tool.includes("/") || tool === "" || tool === "." || tool === "..") {
    return ""
  }
  for (const entry of pathValue.split(":")) {
    if (!entry.startsWith("/")) {
      continue
    }
    const candidate = entry === "/" ? "/" + tool : entry + "/" + tool
    if (!isExecutableFile(candidate)) {
      continue
    }
    if (isStandinFile(candidate)) {
      continue
    }
    return candidate
  }
  return ""
}

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

const standinDecideFn = (decide: ReadonlyArray<string>): ReadonlyArray<string> => [
  'heavy_decide() {',
  '  heavy_queue=0; heavy_prio=0;',
  ...decide,
  '}'
]

export const standinScript = (tool: string, settings: StandinSettings, commands: ReadonlyArray<string>, timing?: StandinTiming): string => {
  const decide = defaultHeavyTools.includes(tool) ? [...decideBody(tool), ...extraSub(tool, commands)] : extraSub(tool, commands)
  const resolved = findRealTool(tool, process.env.PATH ?? "")
  return [
    ...standinHead(tool, settings, resolved),
    ...helpers,
    ...standinDecideFn(decide),
    ...standinUtils(),
    ...standinQueue(settings.through),
    ...standinWait(timing),
    ...standinFinish()
  ].join("\n") + "\n"
}

export const standinScripts = (
  settings: StandinSettings,
  commands: ReadonlyArray<string>,
  tools: ReadonlyArray<string> = standinTools(commands),
  timing?: StandinTiming
): Record<string, string> => Object.fromEntries(tools.map((tool) => [tool, standinScript(tool, settings, commands, timing)]))
