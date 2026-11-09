import { defaultHeavyTools } from "./heavy"

export type HeavyPlatform = "darwin" | "linux" | "other"

export interface StandinSettings {
  readonly home: string
  readonly group: string
  readonly wrap: string
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
  '    case "$heavy_a" in --watch|--watchAll|--watch-all|--interactive) return 0;; esac',
  '  done',
  '  return 1',
  '}',
  '',
  'heavy_targeted() {',
  '  for heavy_a in "$@"; do',
  '    case "$heavy_a" in',
  '      --changed|-t|--test-name-pattern|-g|--grep|-k|-run) return 0;;',
  '      *.test.*|*.spec.*|*_test.go|*_test.py|*/test_*.py) return 0;;',
  '      -*) ;;',
  '      ./...|.) ;;',
  '      */*) return 0;;',
  '    esac',
  '  done',
  '  return 1',
  '}',
  '',
  'heavy_exec_tool() {',
  '  case "$1" in -*) return;; esac',
  '  case "$1" in',
  '    checks-*|vitest|playwright|jest|tsc|eslint|oxlint)',
  '      shift; heavy_queue=1; if heavy_targeted "$@"; then heavy_prio=1; fi;;',
  '  esac',
  '}',
  '',
  'heavy_run_script() {',
  '  heavy_script=""',
  '  for heavy_a in "$@"; do',
  '    case "$heavy_a" in',
  '      dev|start|serve|preview|watch|storybook|test|tests|lint|typecheck|build|check|checks|e2e|coverage|mutation|checks-*|test:*) heavy_script="$heavy_a"; break;;',
  '    esac',
  '  done',
  '  case "$heavy_script" in',
  '    ""|dev|start|serve|preview|watch|storybook) return;;',
  '  esac',
  '  while [ $# -gt 0 ] && [ "$1" != "$heavy_script" ]; do shift; done',
  '  shift',
  '  heavy_queue=1; if heavy_targeted "$@"; then heavy_prio=1; fi',
  '}'
]
const decideBody = (tool: string): ReadonlyArray<string> => {
  switch (tool) {
    case "bun": {
      return [
        '  if [ $# -eq 0 ]; then return; fi',
        '  if heavy_watchflag "$@" || heavy_version "$@"; then return; fi',
        '  case "$1" in',
        '    test) shift; heavy_queue=1; if heavy_targeted "$@"; then heavy_prio=1; fi;;',
        '    run) shift; heavy_run_script "$@";;',
        '    x) shift; heavy_exec_tool "$@";;',
        '    build) heavy_queue=1;;',
        '  esac'
      ]
    }
    case "bunx":
    case "npx": {
      return [
        '  if [ $# -eq 0 ]; then return; fi',
        '  if heavy_watchflag "$@" || heavy_version "$@"; then return; fi',
        '  heavy_exec_tool "$@"'
      ]
    }
    case "npm":
    case "pnpm":
    case "yarn": {
      return [
        '  if [ $# -eq 0 ]; then return; fi',
        '  if heavy_watchflag "$@" || heavy_version "$@"; then return; fi',
        '  case "$1" in',
        '    run) shift; heavy_run_script "$@";;',
        '    exec) shift; heavy_exec_tool "$@";;',
        '    test|tests|lint|typecheck|build|check|checks|e2e|coverage|mutation|checks-*|test:*)',
        '      shift; heavy_queue=1; if heavy_targeted "$@"; then heavy_prio=1; fi;;',
        '  esac'
      ]
    }
    case "vitest":
    case "jest":
    case "pytest":
    case "tsc":
    case "oxlint":
    case "eslint": {
      return [
        '  if heavy_watchflag "$@" || heavy_version "$@"; then return; fi',
        '  heavy_queue=1; if heavy_targeted "$@"; then heavy_prio=1; fi'
      ]
    }
    case "playwright": {
      return [
        '  if heavy_watchflag "$@" || heavy_version "$@"; then return; fi',
        '  if [ "${1:-}" = "test" ]; then',
        '    shift; heavy_queue=1; if heavy_targeted "$@"; then heavy_prio=1; fi',
        '  fi'
      ]
    }
    case "go": {
      return [
        '  case "${1:-}" in ""|-*) return;; esac',
        '  if heavy_watchflag "$@" || heavy_version "$@"; then return; fi',
        '  case "$1" in',
        '    test|build|vet) shift; heavy_queue=1; if heavy_targeted "$@"; then heavy_prio=1; fi;;',
        '  esac'
      ]
    }
    case "cargo": {
      return [
        '  case "${1:-}" in ""|-*) return;; esac',
        '  if heavy_watchflag "$@" || heavy_version "$@"; then return; fi',
        '  case "$1" in',
        '    test|build|clippy) shift; heavy_queue=1; if heavy_targeted "$@"; then heavy_prio=1; fi;;',
        '  esac'
      ]
    }
    case "xcodebuild": {
      return [
        '  if heavy_version "$@"; then return; fi',
        '  heavy_queue=1'
      ]
    }
    case "xcrun": {
      return [
        '  if [ "${1:-}" = "simctl" ]; then',
        '    case "${2:-}" in boot|io) heavy_queue=1;; esac',
        '  fi'
      ]
    }
    default: {
      return [
        '  if heavy_watchflag "$@" || heavy_version "$@"; then return; fi',
        '  heavy_queue=1; if heavy_targeted "$@"; then heavy_prio=1; fi'
      ]
    }
  }
}

const extraSub = (tool: string, commands: ReadonlyArray<string>): ReadonlyArray<string> => {
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
const standinHead = (tool: string, settings: StandinSettings): ReadonlyArray<string> => [
    '#!/bin/sh',
    '# Written by orc heavy path. Regenerated on every run of that command.',
    'heavy_tool="' + tool + '"',
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

const standinUtils = (): ReadonlyArray<string> => [
    'heavy_selfdir() {',
    '  CDPATH= cd -- "$(dirname -- "$0")" && pwd',
    '}',
    '',
    'heavy_real() {',
    '  heavy_dir="$(heavy_selfdir)"',
    '  heavy_oldifs="$IFS"; IFS=:',
    '  for heavy_d in $PATH; do',
    '    if [ -z "$heavy_d" ]; then heavy_d=.; fi',
    '    case "$heavy_d/" in "$heavy_dir"/) continue;; esac',
    '    if [ -x "$heavy_d/$heavy_tool" ] && [ ! -d "$heavy_d/$heavy_tool" ]; then',
    '      printf "%s" "$heavy_d/$heavy_tool"',
    '      break',
    '    fi',
    '  done',
    '  IFS="$heavy_oldifs"',
    '}',
    '',
    'heavy_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }',
    '',
    'heavy_jsonesc() {',
    '  printf "%s" "$1" | tr -d \'\\n\\r\\t"\\\\\'',
    '}',
    '',
    'heavy_bypass_event() {',
    '  heavy_reason="$1"; shift',
    '  heavy_esc_reason="$(heavy_jsonesc "$heavy_reason")"',
    '  heavy_esc_command="$(heavy_jsonesc "$heavy_tool $*")"',
    '  mkdir -p "$heavy_home/backlog" 2>/dev/null || true',
    '  heavy_line=\'{"rule":"heavy-bypass","at":"\'$(heavy_now)\'","reason":"\'"$heavy_esc_reason"\'","command":"\'"$heavy_esc_command"\'"}\'',
    '  if ! printf "%s\n" "$heavy_line" >> "$heavy_home/backlog/alerts.jsonl" 2>/dev/null; then',
    '    echo "orc heavy: cannot write the bypass log at $heavy_home/backlog/alerts.jsonl" >&2',
    '  fi',
    '}',
    '',
    'heavy_task_status() {',
    '  pueue log --json "$1" 2>/dev/null | grep -o \'"status":{"[A-Za-z]*\' | head -1 | cut -d\\" -f4',
    '}',
    '',
    'heavy_queued_ahead() {',
    '  heavy_total=$(pueue status --json --group "$heavy_group" 2>/dev/null | grep -o \'"status":{"Queued"\' | wc -l)',
    '  heavy_total=$(printf "%s" "$heavy_total" | tr -d " ")',
    '  case "$heavy_total" in ""|*[!0-9]*) heavy_total=0;; esac',
    '  case "$(heavy_task_status "$1")" in',
    '    Queued) heavy_total=$((heavy_total - 1));;',
    '  esac',
    '  if [ "$heavy_total" -lt 0 ]; then heavy_total=0; fi',
    '  printf "%s" "$heavy_total"',
    '}',
    '',
    'heavy_place() {',
    '  echo "orc heavy: waiting $2s for the $heavy_group queue, $(heavy_queued_ahead "$1") queued ahead in $heavy_group" >&2',
    '}',
    '',
    'heavy_remove() {',
    '  case "$(heavy_task_status "$1")" in',
    '    Running) pueue kill "$1" >/dev/null 2>&1;;',
    '    *) pueue remove "$1" >/dev/null 2>&1;;',
    '  esac',
    '}',
]

const standinMain = (): ReadonlyArray<string> => [
    'heavy_main() {',
    '  heavy_real_bin="$(heavy_real)"',
    '  if [ -z "$heavy_real_bin" ]; then',
    '    echo "orc heavy: no $heavy_tool beyond the stand-in folder on PATH" >&2',
    '    return 127',
    '  fi',
    '  if [ "$PUEUE_GROUP" = "$heavy_group" ] && [ -n "$PUEUE_WORKER_ID" ]; then',
    '    exec "$heavy_real_bin" "$@"',
    '  fi',
    '  if [ -n "$HEAVY_QUEUE_BYPASS" ]; then',
    '    heavy_bypass_event "$HEAVY_QUEUE_BYPASS" "$@"',
    '    echo "orc heavy: bypassing the $heavy_group queue: $HEAVY_QUEUE_BYPASS" >&2',
    '    exec "$heavy_real_bin" "$@"',
    '  fi',
    '  heavy_decide "$@"',
    '  if [ "$heavy_queue" = 0 ]; then',
    '    exec "$heavy_real_bin" "$@"',
    '  fi',
    '  if ! pueue group --json >/dev/null 2>&1; then',
    '    echo "orc heavy: pueue is unreachable; repair pueue (pueue status) or bypass once with HEAVY_QUEUE_BYPASS=<reason>" >&2',
    '    return 1',
    '  fi',
    '  if [ "$heavy_prio" = 1 ]; then',
    '    heavy_id="$(pueue add --group "$heavy_group" -o 1 --working-directory "$PWD" --print-task-id --escape -- $heavy_wrap "$heavy_real_bin" "$@" 2>&1)" || {',
    '      echo "orc heavy: pueue refused the task; repair pueue (pueue status) or bypass once with HEAVY_QUEUE_BYPASS=<reason>" >&2',
    '      return 1',
    '    }',
    '  else',
    '    heavy_id="$(pueue add --group "$heavy_group" --working-directory "$PWD" --print-task-id --escape -- $heavy_wrap "$heavy_real_bin" "$@" 2>&1)" || {',
    '      echo "orc heavy: pueue refused the task; repair pueue (pueue status) or bypass once with HEAVY_QUEUE_BYPASS=<reason>" >&2',
    '      return 1',
    '    }',
    '  fi',
    '  case "$heavy_id" in \'\'|*[!0-9]*) echo "orc heavy: pueue refused the task: $heavy_id" >&2; return 1;; esac',
    ...standinWait(),
    '  trap - INT TERM HUP',
    '  pueue follow "$heavy_id" 2>/dev/null || true',
    '  heavy_result="$(pueue log --json "$heavy_id" 2>/dev/null)"',
    '  case "$heavy_result" in',
    '    *\'"result":"Success"\'*) return 0;;',
    '    *\'"FailedToSpawn"\'*) return 127;;',
    '    *\'"Killed"\'*|*\'"Errored"\'*|*\'"DependencyFailed"\'*) return 1;;',
    '    *\'"Failed":\'*)',
    '      heavy_code="$(printf "%s" "$heavy_result" | grep -o \'"Failed":[0-9]*\' | head -1 | cut -d: -f2)"',
    '      case "$heavy_code" in \'\'|*[!0-9]*) return 1;; *) return "$heavy_code";; esac;;',
    '    *) return 1;;',
    '  esac',
    '}',
    '',
    'heavy_main "$@"',
    ''
]

const standinWait = (): ReadonlyArray<string> => [
    '  heavy_on_signal() {',
    '    heavy_remove "$heavy_id"',
    '    exit 130',
    '  }',
    '  trap heavy_on_signal INT TERM HUP',
    '  if [ "$GITHUB_ACTIONS" = "true" ]; then',
    '    heavy_budget=30',
    '  else',
    '    heavy_budget=""',
    '  fi',
    '  if [ -n "$ORC_HEAVY_TEST_WAIT_MINUTES" ]; then',
    '    heavy_budget="$ORC_HEAVY_TEST_WAIT_MINUTES"',
    '  fi',
    '  heavy_poll=60',
    '  if [ -n "$ORC_HEAVY_TEST_POLL_SECONDS" ]; then',
    '    heavy_poll="$ORC_HEAVY_TEST_POLL_SECONDS"',
    '  fi',
    '  case "$heavy_poll" in ""|*[!0-9]*|0) heavy_poll=60;; esac',
    '  heavy_elapsed=0',
    '  heavy_polls=0',
    '  heavy_ticks=0',
    '  heavy_misses=0',
    '  while :; do',
    '    heavy_state="$(pueue log --json "$heavy_id" 2>/dev/null)" || heavy_state=""',
    '    case "$heavy_state" in',
    '      *\'"status":{"Done"\'*) break;;',
    '      *\'"status":{"Queued"\'*|*\'"status":{"Running"\'*) heavy_misses=0;;',
    '      *)',
    '        heavy_misses=$((heavy_misses + 1))',
    '        if [ "$heavy_misses" -ge 3 ]; then',
    '          echo "orc heavy: pueue lost the queued task; repair pueue (pueue status) or bypass once with HEAVY_QUEUE_BYPASS=<reason>" >&2',
    '          return 1',
    '        fi;;',
    '    esac',
    '    sleep 1 2>/dev/null || break',
    '    heavy_elapsed=$((heavy_elapsed + 1))',
    '    heavy_polls=$((heavy_polls + 1))',
    '    if [ "$heavy_polls" -ge "$heavy_poll" ]; then',
    '      heavy_polls=0',
    '      heavy_ticks=$((heavy_ticks + 1))',
    '      case "$heavy_budget" in',
    '        ""|*[!0-9]*) ;;',
    '        *)',
    '          if [ "$heavy_elapsed" -ge $((heavy_budget * 60)) ]; then',
    '            case "$(heavy_task_status "$heavy_id")" in',
    '              Queued)',
    '                heavy_ahead=$(heavy_queued_ahead "$heavy_id")',
    '                heavy_remove "$heavy_id"',
    '                echo "orc heavy: waited $heavy_budget min for the heavy queue, $heavy_ahead ahead in $heavy_group" >&2',
    '                exit 1;;',
    '            esac',
    '          fi;;',
    '      esac',
    '      if [ "$heavy_ticks" -ge 3 ]; then',
    '        heavy_ticks=0',
    '        case "$(heavy_task_status "$heavy_id")" in',
    '          Queued|Running) heavy_place "$heavy_id" "$heavy_elapsed";;',
    '        esac',
    '      fi',
    '    fi',
    '  done',
    '  trap - INT TERM HUP',
]

export const standinScript = (tool: string, settings: StandinSettings, commands: ReadonlyArray<string>): string => {
  const decide = defaultHeavyTools.includes(tool) ? decideBody(tool) : extraSub(tool, commands)
  return [...standinHead(tool, settings), ...helpers, ...standinDecideFn(decide), ...standinUtils(), ...standinMain()].join("\n") + "\n"
}

export const standinScripts = (
  settings: StandinSettings,
  commands: ReadonlyArray<string>,
  tools: ReadonlyArray<string> = standinTools(commands)
): Record<string, string> => Object.fromEntries(tools.map((tool) => [tool, standinScript(tool, settings, commands)]))
