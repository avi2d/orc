const pmStrip: ReadonlyArray<string> = [
  '  while [ $# -gt 0 ]; do',
  '    case "$1" in',
  '      --filter|-F|--workspace|-w|--prefix) shift; if [ $# -eq 0 ]; then break; fi; shift; if [ $# -eq 0 ]; then break; fi;;',
  '      --filter=*|--workspace=*|--prefix=*) shift;;',
  '      -r|--recursive) shift;;',
  '      workspace) shift; if [ $# -eq 0 ]; then break; fi; shift; if [ $# -eq 0 ]; then break; fi;;',
  '      *) break;;',
  '    esac',
  '  done',
  '  if [ $# -eq 0 ]; then return; fi'
]

const bunStrip: ReadonlyArray<string> = [
  '  while [ $# -gt 0 ]; do',
  '    case "$1" in',
  '      --filter) shift; if [ $# -eq 0 ]; then break; fi; shift; if [ $# -eq 0 ]; then break; fi;;',
  '      --filter=*) shift;;',
  '      *) break;;',
  '    esac',
  '  done',
  '  if [ $# -eq 0 ]; then return; fi'
]

const bunDecide = (): ReadonlyArray<string> => [
  '  if [ $# -eq 0 ]; then return; fi',
  ...bunStrip,
  '  if heavy_watchflag "$@" || heavy_version "$@"; then return; fi',
  '  case "$1" in',
  '    test) shift; heavy_queue=1; if heavy_targeted_bare "$@"; then heavy_prio=1; fi;;',
  '    run) shift; heavy_run_script "$@";;',
  '    x) shift; heavy_exec_tool "$@";;',
  '    build) heavy_queue=1;;',
  '    *) heavy_exec_tool "$@";;',
  '  esac'
]

const npxDecide = (): ReadonlyArray<string> => [
  '  if [ $# -eq 0 ]; then return; fi',
  '  if heavy_watchflag "$@" || heavy_version "$@"; then return; fi',
  '  heavy_exec_tool "$@"'
]

const npmDecide = (): ReadonlyArray<string> => [
  '  if [ $# -eq 0 ]; then return; fi',
  ...pmStrip,
  '  if heavy_watchflag "$@" || heavy_version "$@"; then return; fi',
  '  case "$1" in',
  '    run) shift; heavy_run_script "$@";;',
  '    exec) shift; if [ "${1:-}" = "--" ]; then shift; fi; heavy_exec_tool "$@";;',
  '    *:watch|*:ui|*:dev) return;;',
  '    test|tests|t|lint|typecheck|build|check|checks|e2e|coverage|mutation|checks-*|test:*)',
  '      shift; heavy_queue=1; if heavy_targeted "$@"; then heavy_prio=1; fi;;',
  '    build:*|lint:*|typecheck:*)',
  '      shift; heavy_queue=1; if heavy_targeted "$@"; then heavy_prio=1; fi;;',
  '    *) heavy_exec_tool "$@";;',
  '  esac'
]

const pnpmDecide = (): ReadonlyArray<string> => [
  '  if [ $# -eq 0 ]; then return; fi',
  ...pmStrip,
  '  if heavy_watchflag "$@" || heavy_version "$@"; then return; fi',
  '  case "$1" in',
  '    run) shift; heavy_run_script "$@";;',
  '    exec) shift; if [ "${1:-}" = "--" ]; then shift; fi; heavy_exec_tool "$@";;',
  '    *:watch|*:ui|*:dev) return;;',
  '    test|tests|lint|typecheck|build|check|checks|e2e|coverage|mutation|checks-*|test:*)',
  '      shift; heavy_queue=1; if heavy_targeted "$@"; then heavy_prio=1; fi;;',
  '    build:*|lint:*|typecheck:*)',
  '      shift; heavy_queue=1; if heavy_targeted "$@"; then heavy_prio=1; fi;;',
  '    *) heavy_exec_tool "$@";;',
  '  esac'
]

const vitestDecide = (): ReadonlyArray<string> => [
  '  if heavy_watchflag "$@" || heavy_version "$@"; then return; fi',
  '  case "${1:-}" in watch|dev) return;; esac',
  '  for heavy_a in "$@"; do case "$heavy_a" in -w) return;; esac; done',
  '  if [ "${1:-}" = "run" ]; then shift; fi',
  '  heavy_queue=1; if heavy_targeted_bare "$@"; then heavy_prio=1; fi'
]

const jestDecide = (): ReadonlyArray<string> => [
  '  if heavy_watchflag "$@" || heavy_version "$@"; then return; fi',
  '  heavy_queue=1; if heavy_targeted_bare "$@"; then heavy_prio=1; fi'
]

const tscDecide = (): ReadonlyArray<string> => [
  '  if heavy_watchflag "$@" || heavy_version "$@"; then return; fi',
  '  for heavy_a in "$@"; do case "$heavy_a" in -w) return;; esac; done',
  '  heavy_queue=1; if heavy_targeted "$@"; then heavy_prio=1; fi'
]

const pytestDecide = (): ReadonlyArray<string> => [
  '  if heavy_watchflag "$@" || heavy_version "$@"; then return; fi',
  '  heavy_queue=1; if heavy_targeted "$@"; then heavy_prio=1; fi'
]

const playwrightDecide = (): ReadonlyArray<string> => [
  '  if heavy_watchflag "$@" || heavy_version "$@"; then return; fi',
  '  if [ "${1:-}" = "test" ]; then',
  '    shift; heavy_queue=1; if heavy_targeted "$@"; then heavy_prio=1; fi',
  '  fi'
]

const goDecide = (): ReadonlyArray<string> => [
  '  case "${1:-}" in ""|-*) return;; esac',
  '  if heavy_watchflag "$@" || heavy_version "$@"; then return; fi',
  '  case "$1" in',
  '    test|build|vet) shift; heavy_queue=1; if heavy_targeted "$@"; then heavy_prio=1; fi;;',
  '  esac'
]

const cargoDecide = (): ReadonlyArray<string> => [
  '  case "${1:-}" in ""|-*) return;; esac',
  '  if heavy_watchflag "$@" || heavy_version "$@"; then return; fi',
  '  case "$1" in',
  '    test|build|clippy) shift; heavy_queue=1; if heavy_targeted "$@"; then heavy_prio=1; fi;;',
  '  esac'
]

const xcodeDecide = (): ReadonlyArray<string> => [
  '  if heavy_version "$@"; then return; fi',
  '  heavy_queue=1'
]

const xcrunDecide = (): ReadonlyArray<string> => [
  '  if [ "${1:-}" = "simctl" ]; then',
  '    case "${2:-}" in boot|io) heavy_queue=1;; esac',
  '  fi'
]

export const decideBody = (tool: string): ReadonlyArray<string> => {
  switch (tool) {
    case "bun":
      return bunDecide()
    case "bunx":
    case "npx":
      return npxDecide()
    case "npm":
      return npmDecide()
    case "pnpm":
    case "yarn":
      return pnpmDecide()
    case "vitest":
      return vitestDecide()
    case "jest":
      return jestDecide()
    case "tsc":
      return tscDecide()
    case "pytest":
    case "oxlint":
    case "eslint":
      return pytestDecide()
    case "playwright":
      return playwrightDecide()
    case "go":
      return goDecide()
    case "cargo":
      return cargoDecide()
    case "xcodebuild":
      return xcodeDecide()
    case "xcrun":
      return xcrunDecide()
    default:
      return []
  }
}

export const extraSub = (tool: string, commands: ReadonlyArray<string>): ReadonlyArray<string> => {
  const bare = commands.some((entry) => entry.trim() === tool)
  const subs = commands
    .map((entry) => entry.trim().split(" "))
    .filter((parts) => parts.length === 2 && parts[0] === tool)
    .map((parts) => parts[1] ?? "")
    .filter((sub) => sub !== "")
  if (bare) {
    return [
      '  if heavy_watchflag "$@" || heavy_version "$@"; then return; fi',
      '  heavy_queue=1; if heavy_targeted "$@"; then heavy_prio=1; fi'
    ]
  }
  if (subs.length === 0) {
    return []
  }
  return [
    '  if heavy_watchflag "$@" || heavy_version "$@"; then return; fi',
    '  case "${1:-}" in',
    ...subs.map((sub) => '    ' + sub + ') shift; heavy_queue=1; if heavy_targeted "$@"; then heavy_prio=1; fi;;'),
    '  esac'
  ]
}
