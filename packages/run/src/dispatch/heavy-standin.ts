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
  '    if heavy_valueflag "$1"; then shift; if [ $# -eq 0 ]; then break; fi; shift; if [ $# -eq 0 ]; then break; fi; fi',
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
  '    if heavy_valueflag "$1"; then shift; if [ $# -eq 0 ]; then break; fi; shift; if [ $# -eq 0 ]; then break; fi; fi',
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
  '      shift; case "${1:-}" in watch) return;; esac',
  '      if [ "${1:-}" = "run" ]; then shift; fi',
  '      heavy_queue=1; if heavy_targeted_bare "$@"; then heavy_prio=1; fi;;',
  '    jest)',
  '      shift; heavy_queue=1; if heavy_targeted_bare "$@"; then heavy_prio=1; fi;;',
  '    playwright|tsc|eslint|oxlint)',
  '      shift; heavy_queue=1; if heavy_targeted "$@"; then heavy_prio=1; fi;;',
  '  esac',
  '}',
  '',
  'heavy_run_script() {',
  '  heavy_script=""',
  '  for heavy_a in "$@"; do',
  '    case "$heavy_a" in',
  '      dev|start|serve|preview|watch|storybook|test|tests|lint|typecheck|build|check|checks|e2e|coverage|mutation|checks-*|test:*|build:*|lint:*|typecheck:*|vitest|jest|tsc|eslint|oxlint|playwright) heavy_script="$heavy_a"; break;;',
  '    esac',
  '  done',
  '  case "$heavy_script" in',
  '    ""|dev|start|serve|preview|watch|storybook|*:watch|*:ui|*:dev) return;;',
  '  esac',
  '  while [ $# -gt 0 ] && [ "$1" != "$heavy_script" ]; do shift; done',
  '  shift',
  '  if heavy_watchflag "$@"; then return; fi',
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
        '    test) shift; heavy_queue=1; if heavy_targeted_bare "$@"; then heavy_prio=1; fi;;',
        '    run) shift; heavy_run_script "$@";;',
        '    x) shift; heavy_exec_tool "$@";;',
        '    build) heavy_queue=1;;',
        '    *) heavy_exec_tool "$@";;',
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
        '    *:watch|*:ui|*:dev) return;;',
        '    test|tests|lint|typecheck|build|check|checks|e2e|coverage|mutation|checks-*|test:*)',
        '      shift; heavy_queue=1; if heavy_targeted "$@"; then heavy_prio=1; fi;;',
        '    build:*|lint:*|typecheck:*)',
        '      shift; heavy_queue=1; if heavy_targeted "$@"; then heavy_prio=1; fi;;',
        '    *) heavy_exec_tool "$@";;',
        '  esac'
      ]
    }
    case "vitest": {
      return [
        '  if heavy_watchflag "$@" || heavy_version "$@"; then return; fi',
        '  case "${1:-}" in watch) return;; esac',
        '  if [ "${1:-}" = "run" ]; then shift; fi',
        '  heavy_queue=1; if heavy_targeted_bare "$@"; then heavy_prio=1; fi'
      ]
    }
    case "jest": {
      return [
        '  if heavy_watchflag "$@" || heavy_version "$@"; then return; fi',
        '  heavy_queue=1; if heavy_targeted_bare "$@"; then heavy_prio=1; fi'
      ]
    }
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
    default: return []
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
    'heavy_unwrap() {',
    '  heavy_u="$1"',
    '  case "$heavy_u" in *orc-heavy-wait\\ *)',
    '    heavy_u="${heavy_u#*orc-heavy-wait }"; heavy_u="${heavy_u#* }";;',
    '  esac',
    '  case "$heavy_u" in "taskpolicy -c utility "*) heavy_u="${heavy_u#taskpolicy -c utility }";; esac',
    '  printf "%s" "$heavy_u"',
    '}',
    '',
    'heavy_inside_slot() {',
    '  if [ "$PUEUE_GROUP" = "$heavy_group" ]; then return 0; fi',
    '  heavy_state_json="$(pueue status --json -g "$heavy_group" 2>/dev/null)" || return 1',
    '  heavy_cmds="$(printf "%s" "$heavy_state_json" | grep -E -o \'"command":"(\\.|[^"\\])*"\')"',
    '  if [ -z "$heavy_cmds" ]; then return 1; fi',
    '  heavy_cmds="$(printf "%s\\n" "$heavy_cmds" | while IFS= read -r heavy_cl; do heavy_unwrap "$heavy_cl"; printf "\\n"; done)"',
    '  heavy_tree="$(ps -eo pid,ppid,command 2>/dev/null)" || return 1',
    '  heavy_pid=$$; heavy_depth=0; heavy_selfhit=0; heavy_anchit=0; heavy_pueue=0',
    '  while :; do',
    '    heavy_acmd="$(printf "%s\\n" "$heavy_tree" | awk -v p="$heavy_pid" \'$1 == p { $1=""; $2=""; sub(/^  */, ""); print; exit }\')"',
    '    heavy_acmd="$(heavy_unwrap "$heavy_acmd")"',
    '    if [ -z "$heavy_acmd" ]; then return 1; fi',
    '    if [ "$heavy_depth" = 0 ]; then heavy_selfv=1; else heavy_selfv=0; fi',
    '    heavy_abin="$(printf "%s" "$heavy_acmd" | awk \'{ print $1; exit }\')"',
    '    heavy_abin="${heavy_abin##*/}"',
    '    case "$heavy_abin" in pueue|pueued) heavy_pueue=1;; esac',
    '    heavy_amatch="$heavy_acmd"',
    '    case "$heavy_amatch" in sh\\ -c\\ *|bash\\ -c\\ *|dash\\ -c\\ *|zsh\\ -c\\ *|*/sh\\ -c\\ *|*/bash\\ -c\\ *) heavy_amatch="${heavy_amatch#* -c }";; esac',
    '    if printf "%s\\n" "$heavy_cmds" | awk -v a="$heavy_acmd" -v s="$heavy_amatch" -v self="$heavy_selfv" \'',
    '      BEGIN { gsub(/["\\047\\\\]/, "", a); gsub(/["\\047\\\\]/, "", s) }',
    '      { c = $0; gsub(/["\\047\\\\]/, "", c);',
    '        if (c != "" && (self ? (index(a, c) > 0 || index(c, a) > 0) : (c == a || c == s))) { found = 1; exit } }',
    '      END { exit found ? 0 : 1 }\'; then',
    '      if [ "$heavy_depth" = 0 ]; then heavy_selfhit=1; else heavy_anchit=1; fi',
    '    fi',
    '    heavy_ppid="$(printf "%s\\n" "$heavy_tree" | awk -v p="$heavy_pid" \'$1 == p { print $2; exit }\')"',
    '    case "$heavy_ppid" in ""|0) break;; esac',
    '    heavy_pid="$heavy_ppid"; heavy_depth=$((heavy_depth + 1))',
    '  done',
    '  if [ "$heavy_anchit" = 1 ]; then return 0; fi',
    '  if [ "$heavy_selfhit" = 1 ] && [ "$heavy_pueue" = 1 ]; then return 0; fi',
    '  return 1',
    '}',
    '',
    'heavy_queued_ahead() {',
    '  pueue status --json -g "$heavy_group" 2>/dev/null | awk -v mine="$1" \'',
    '    function save(text,   id, prio, st) {',
    '      if (!match(text, /"id":[0-9]+/)) return;',
    '      id = substr(text, RSTART + 5, RLENGTH - 5);',
    '      prio = 0;',
    '      if (match(text, /"priority":-?[0-9]+/)) prio = substr(text, RSTART + 11, RLENGTH - 11);',
    '      st = "?";',
    '      if (match(text, /"status":\{"[A-Za-z]+/)) st = substr(text, RSTART + 11, RLENGTH - 11);',
    '      ids[n] = id; prios[n] = prio; sts[n] = st; n++;',
    '    }',
    '    {',
    '      line = $0;',
    '      for (i = 1; i <= length(line); i++) {',
    '        c = substr(line, i, 1);',
    '        if (in_str) {',
    '          if (esc) esc = 0;',
    '          else if (c == "\\\\") esc = 1;',
    '          else if (c == "\\"") in_str = 0;',
    '          if (depth >= 2) chunk = chunk c; else if (depth == 1) prefix = prefix c;',
    '        } else if (c == "\\"") { if (depth == 2 && intask && chunk != "") { save(chunk); chunk = ""; } in_str = 1; if (depth >= 2) chunk = chunk c; else if (depth == 1) prefix = prefix c; }',
    '        else if (c == "{") {',
    '          depth++;',
    '          if (depth == 2) {',
    '            if (prefix ~ /"tasks"[ \\t]*:[ \\t]*$/) { chunk = ""; intask = 1; }',
    '            else intask = 0;',
    '          } else if (depth > 2) chunk = chunk c;',
    '          prefix = "";',
    '        } else if (c == "}") {',
    '          depth--;',
    '          if (depth == 1) { if (intask && chunk != "") save(chunk); intask = 0; chunk = ""; }',
    '          else if (depth >= 2) chunk = chunk c;',
    '          prefix = "";',
    '        } else {',
    '          if (depth >= 2) chunk = chunk c;',
    '          else if (depth == 1) prefix = prefix c;',
    '        }',
    '      }',
    '    }',
    '    END {',
    '      myprio = 0;',
    '      for (i = 0; i < n; i++) if (ids[i] == mine) myprio = prios[i] + 0;',
    '      ahead = 0;',
    '      for (i = 0; i < n; i++) {',
    '        if (sts[i] != "Queued") continue;',
    '        if (prios[i] + 0 > myprio || (prios[i] + 0 == myprio && ids[i] + 0 < mine + 0)) ahead++;',
    '      }',
    '      print ahead + 0;',
    '    }\'',
    '}',
    '',
    'heavy_place() {',
    '  heavy_placestate="$(heavy_task_status "$1")"',
    '  case "$heavy_placestate" in',
    '    Queued) echo "orc heavy: waiting $2s for the $heavy_group queue, $(heavy_queued_ahead "$1") queued ahead in $heavy_group" >&2;;',
    '    Running) echo "orc heavy: running $2s in the $heavy_group queue" >&2;;',
    '    Paused|Stashed|Locked)',
    '      heavy_placeword="$(printf "%s" "$heavy_placestate" | tr "A-Z" "a-z")"',
    '      echo "orc heavy: $heavy_placeword $2s in the $heavy_group queue" >&2;;',
    '  esac',
    '}',
    '',
    'heavy_remove() {',
    '  case "$(heavy_task_status "$1")" in',
    '    Running) pueue kill "$1" >/dev/null 2>&1;;',
    '    *) pueue remove "$1" >/dev/null 2>&1;;',
    '  esac',
    '}',
]

const waiterBody =
  'o=$1; shift; "$@" & c=$!; ' +
  '(while kill -0 "$o" 2>/dev/null && kill -0 "$c" 2>/dev/null; do sleep 5; done; kill "$c" 2>/dev/null) & k=$!; ' +
  'trap "kill $c 2>/dev/null; kill $k 2>/dev/null" TERM INT; wait "$c"; r=$?; kill "$k" 2>/dev/null; wait "$k" 2>/dev/null; exit "$r"'

const waiterAdd =
  'sh -c ' + "'" + waiterBody + "'" + ' orc-heavy-wait $$ $heavy_wrap "$heavy_real_bin" "$@"'

const standinQueue = (): ReadonlyArray<string> => [
    'heavy_main() {',
    '  if [ -n "$HEAVY_CLASSIFY" ]; then',
    '    heavy_decide "$@"',
    '    echo "$heavy_queue $heavy_prio"',
    '    return 0',
    '  fi',
    '  heavy_real_bin="$(heavy_real)"',
    '  if [ -z "$heavy_real_bin" ]; then',
    '    echo "orc heavy: no $heavy_tool beyond the stand-in folder on PATH" >&2',
    '    return 127',
    '  fi',
    '  heavy_decide "$@"',
    '  if [ "$heavy_queue" = 0 ]; then',
    '    exec "$heavy_real_bin" "$@"',
    '  fi',
    '  if [ -n "$HEAVY_QUEUE_BYPASS" ]; then',
    '    if [ "$HEAVY_QUEUE_BYPASSED" != "$HEAVY_QUEUE_BYPASS" ]; then',
    '      heavy_bypass_event "$HEAVY_QUEUE_BYPASS" "$@"',
    '    fi',
    '    export HEAVY_QUEUE_BYPASSED="$HEAVY_QUEUE_BYPASS"',
    '    echo "orc heavy: bypassing the $heavy_group queue: $HEAVY_QUEUE_BYPASS" >&2',
    '    exec "$heavy_real_bin" "$@"',
    '  fi',
    '  if heavy_inside_slot; then',
    '    exec "$heavy_real_bin" "$@"',
    '  fi',
    '  if ! pueue group --json >/dev/null 2>&1; then',
    '    echo "orc heavy: pueue is unreachable; repair pueue (pueue status) or bypass once with HEAVY_QUEUE_BYPASS=<reason>" >&2',
    '    return 1',
    '  fi',
    '  if [ "$heavy_prio" = 1 ]; then',
    '    heavy_id="$(pueue add --group "$heavy_group" -o 1 --working-directory "$PWD" --print-task-id --escape -- ' + waiterAdd + ' 2>&1)" || {',
    '      echo "orc heavy: pueue refused the task; repair pueue (pueue status) or bypass once with HEAVY_QUEUE_BYPASS=<reason>" >&2',
    '      return 1',
    '    }',
    '  else',
    '    heavy_id="$(pueue add --group "$heavy_group" --working-directory "$PWD" --print-task-id --escape -- ' + waiterAdd + ' 2>&1)" || {',
    '      echo "orc heavy: pueue refused the task; repair pueue (pueue status) or bypass once with HEAVY_QUEUE_BYPASS=<reason>" >&2',
    '      return 1',
    '    }',
    '  fi',
    '  case "$heavy_id" in \'\'|*[!0-9]*) echo "orc heavy: pueue refused the task: $heavy_id" >&2; return 1;; esac',
]

const standinFinish = (): ReadonlyArray<string> => [
    '  trap - INT TERM HUP',
    '  pueue follow "$heavy_id" 2>/dev/null || true',
    '  heavy_result="$(pueue log --json "$heavy_id" 2>/dev/null)"',
'  pueue remove "$heavy_id" >/dev/null 2>&1 || true',
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

export interface StandinTiming {
  readonly budgetMinutes: number | null
  readonly pollSeconds: number
}

const standinWait = (timing?: StandinTiming): ReadonlyArray<string> => [
    '  heavy_on_signal() {',
    '    heavy_remove "$heavy_id"',
    '    exit 130',
    '  }',
    '  trap heavy_on_signal INT TERM HUP',
    ...(timing === undefined
      ? [
        '  if [ "$GITHUB_ACTIONS" = "true" ]; then',
        '    heavy_budget=30',
        '  else',
        '    heavy_budget=""',
        '  fi',
        '  heavy_poll=60'
      ]
      : [
        '  heavy_budget=' + (timing.budgetMinutes === null ? '""' : String(timing.budgetMinutes)),
        '  heavy_poll=' + String(timing.pollSeconds)
      ]),
    '  case "$heavy_poll" in ""|*[!0-9]*|0) heavy_poll=60;; esac',
    '  heavy_elapsed=0',
    '  heavy_polls=0',
    '  heavy_ticks=0',
    '  heavy_misses=0',
    '  while :; do',
    '    heavy_state="$(pueue log --json "$heavy_id" 2>/dev/null)" || heavy_state=""',
    '    case "$heavy_state" in',
    '      *\'"status":{"Done"\'*) break;;',
    '      *\'"status":{"Queued"\'*|*\'"status":{"Running"\'*|*\'"status":{"Paused"\'*|*\'"status":{"Stashed"\'*|*\'"status":{"Locked"\'*) heavy_misses=0;;',
    '      *)',
    '        heavy_misses=$((heavy_misses + 1))',
    '        if [ "$heavy_misses" -ge 3 ]; then',
    '          heavy_remove "$heavy_id"',
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
    '          Queued|Running|Paused|Stashed|Locked) heavy_place "$heavy_id" "$heavy_elapsed";;',
    '        esac',
    '      fi',
    '    fi',
    '  done',
    '  trap - INT TERM HUP',
]

export const standinScript = (tool: string, settings: StandinSettings, commands: ReadonlyArray<string>, timing?: StandinTiming): string => {
  const decide = defaultHeavyTools.includes(tool) ? decideBody(tool) : extraSub(tool, commands)
  return [...standinHead(tool, settings), ...helpers, ...standinDecideFn(decide), ...standinUtils(), ...standinQueue(), ...standinWait(timing), ...standinFinish()].join("\n") + "\n"
}

export const standinScripts = (
  settings: StandinSettings,
  commands: ReadonlyArray<string>,
  tools: ReadonlyArray<string> = standinTools(commands),
  timing?: StandinTiming
): Record<string, string> => Object.fromEntries(tools.map((tool) => [tool, standinScript(tool, settings, commands, timing)]))
