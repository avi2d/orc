#!/bin/bash
set -euo pipefail
if [ "$#" -lt 1 ]; then
  echo "usage: with-scratch-app.sh <command> [argument...]" >&2
  exit 2
fi
real_home=$(eval echo "~$(id -un)")
if [ "$HOME" = "$real_home" ]; then
  echo "HOME is the login home; run with a scratch HOME" >&2
  exit 1
fi
case "${HC_SESSION:-}" in
  "") HC_SESSION="fm-lab-$$" ;;
  fm-lab-*) ;;
  *)
    echo "HC_SESSION must start with fm-lab-" >&2
    exit 1
    ;;
esac
export HC_SESSION
live_state=${XDG_STATE_HOME:-$real_home/.local/state}
live=$live_state/herdr-core/default/default.sock
terminals=$live_state/herdr-core/default/terminals.json
export XDG_CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}
export XDG_STATE_HOME=${XDG_STATE_HOME:-$HOME/.local/state}
export XDG_DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
export XDG_CACHE_HOME=${XDG_CACHE_HOME:-$HOME/.cache}
export HERDR_APP_HOME=${HERDR_APP_HOME:-$XDG_CONFIG_HOME/herdr-app}
export HC_SOCKET=${HC_SOCKET:-$XDG_STATE_HOME/scratch-app-core.sock}
if [ "${#HC_SOCKET}" -gt 103 ]; then
  echo "scratch core socket path length ${#HC_SOCKET} exceeds 103" >&2
  exit 1
fi
bundle=${HERDR_APP_BUNDLE:-/Applications/Herdr.app}
app=$bundle/Contents/MacOS/Herdr
for tool in "$app" jq lsof open; do
  if ! command -v "$tool" >/dev/null; then
    echo "missing tool: $tool" >&2
    exit 1
  fi
done
# The App searches the home-relative places under the scratch HOME, where no core is installed.
if [ -n "${HERDR_CORE_DIRS:-}" ]; then
  core_places=HERDR_CORE_DIRS
  core_dirs=$HERDR_CORE_DIRS
else
  core_places="PATH and the login home"
  core_dirs="$PATH:$real_home/.local/bin:$real_home/.local/share/herdr-core/current/Contents/MacOS:$real_home/.local/share/herdr-core/Herdr Core.app/Contents/MacOS:/opt/homebrew/bin:/usr/local/bin:$real_home/.local/share/mise/shims:/run/current-system/sw/bin:$real_home/.cargo/bin"
fi
core_dir=
IFS=: read -r -a core_dir_list <<< "$core_dirs"
for dir in "${core_dir_list[@]}"; do
  if [ -n "$dir" ] && [ -f "$dir/herdr-core" ] && [ -x "$dir/herdr-core" ]; then
    core_dir=$dir
    break
  fi
done
if [ -z "$core_dir" ]; then
  echo "herdr-core not found in $core_places; install it, or set HERDR_CORE_DIRS to the folder that holds it" >&2
  exit 1
fi
export HERDR_CORE_DIRS=${HERDR_CORE_DIRS:-$core_dir}
proof=$HOME/scratch-app-proof
mkdir -p "$proof" "$(dirname "$HC_SOCKET")"
lsof -U 2>/dev/null | grep -F "$live" > "$proof/live-sockets-before" || true
lsof -t "$live" 2>/dev/null | sort -un > "$proof/live-pids-before" || true
while read -r pid; do ps -p "$pid" -o pid=,lstart=; done < "$proof/live-pids-before" > "$proof/live-process-before"
if [ -f "$terminals" ]; then shasum -a 256 "$terminals" > "$proof/terminals-before"; else echo "missing" > "$proof/terminals-before"; fi
pid=
find_app_pid() {
  pid=$(lsof -t "$HERDR_APP_HOME/herdr-app.sock" 2>/dev/null | head -n 1)
  [ -n "$pid" ]
}
app_owns_socket() {
  lsof -a -p "$pid" -U 2>/dev/null | grep -F "$HERDR_APP_HOME/herdr-app.sock" >/dev/null
}
cleanup() {
  code=$?
  trap - EXIT
  set +e
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    if app_owns_socket; then
      "$app" do app.quit >/dev/null 2>&1
      for attempt in $(seq 1 10); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
      if kill -0 "$pid" 2>/dev/null; then
        if ps eww -p "$pid" -o command= | tr ' ' '\n' | grep -Fx "HOME=$HOME" >/dev/null; then
          kill -TERM "$pid" 2>/dev/null || code=1
        else
          echo "scratch App HOME mismatch" >&2
          code=1
        fi
      fi
    else
      kill -TERM "$pid" 2>/dev/null || true
      code=1
    fi
  fi
  if [ -S "$HC_SOCKET" ]; then
    lsof -t "$HC_SOCKET" 2>/dev/null | sort -un > "$proof/scratch-core-pids" || true
    while read -r core; do
      if grep -Fx "$core" "$proof/live-pids-before" >/dev/null; then
        echo "scratch core pid matches live core" >&2
        code=1
      else
        kill -TERM "$core" 2>/dev/null || code=1
      fi
    done < "$proof/scratch-core-pids"
  fi
  lsof -t "$live" 2>/dev/null | sort -un > "$proof/live-pids-after" || true
  while read -r live_pid; do ps -p "$live_pid" -o pid=,lstart=; done < "$proof/live-pids-after" > "$proof/live-process-after"
  if [ -f "$terminals" ]; then shasum -a 256 "$terminals" > "$proof/terminals-after"; else echo "missing" > "$proof/terminals-after"; fi
  cmp "$proof/live-process-before" "$proof/live-process-after" || code=1
  cmp "$proof/terminals-before" "$proof/terminals-after" || code=1
  exit "$code"
}
trap cleanup EXIT
# A home with no welcome outcome opens the welcome over the view.
mkdir -p "$HERDR_APP_HOME"
shared=$HERDR_APP_HOME/shared.json
[ -f "$shared" ] || echo '{}' > "$shared"
jq '."frame.welcomed" = "finished"' "$shared" > "$shared.tmp" && mv "$shared.tmp" "$shared"
echo '{"state":"windowed","bounds":[100,80,1400,900]}' > "$HERDR_APP_HOME/window.json"
# A home with no update record shows the update note over the view.
notes=$HERDR_APP_HOME/update-notes.json
if [ ! -f "$notes" ] && version=$(plutil -extract CFBundleShortVersionString raw -o - "$bundle/Contents/Info.plist" 2>/dev/null); then
  jq -n --arg version "$version" '{last_run: $version, presented: []}' > "$notes"
fi
if find_app_pid; then
  pid=
  echo "an App already runs with HERDR_APP_HOME=$HERDR_APP_HOME" >&2
  exit 1
fi
# Starting the binary itself brings the App to the front; open -g starts it behind the other apps.
launch=(open -g -n -a "$bundle" --stdout "$proof/app.log" --stderr "$proof/app.log")
while IFS= read -r -d '' pair; do
  case "$pair" in
    _=*) ;;
    *) launch+=(--env "$pair") ;;
  esac
done < <(env -0)
# A reused HOME leaves a socket file with no process behind it.
if [ -e "$HC_SOCKET" ] && ! lsof -t "$HC_SOCKET" >/dev/null 2>&1; then
  rm -f "$HC_SOCKET"
fi
"${launch[@]}"
wait_attempts=${HERDR_SCRATCH_WAIT_ATTEMPTS:-175}
wait_seconds=$(awk -v attempts="$wait_attempts" 'BEGIN { printf "%g", attempts * 0.2 }')
for attempt in $(seq 1 "$wait_attempts"); do
  [ -n "$pid" ] || find_app_pid || true
  [ -S "$HC_SOCKET" ] && [ -n "$pid" ] && break
  sleep 0.2
done
if [ -z "$pid" ]; then
  echo "timed out waiting $wait_seconds seconds for the App socket at $HERDR_APP_HOME/herdr-app.sock" >&2
  candidates=""
  for candidate in $(ps -eo pid= 2>/dev/null); do
    if ps eww -p "$candidate" -o command= 2>/dev/null | grep -F "$app" >/dev/null && ps eww -p "$candidate" -o command= 2>/dev/null | tr ' ' '\n' | grep -Fx "HOME=$HOME" >/dev/null; then
      candidates="$candidates $candidate"
      kill -TERM "$candidate" 2>/dev/null || true
    fi
  done
  for attempt in $(seq 1 10); do
    alive=0
    for candidate in $candidates; do kill -0 "$candidate" 2>/dev/null && alive=1; done
    [ "$alive" -eq 0 ] && break
    sleep 0.2
  done
  exit 1
fi
if [ ! -S "$HC_SOCKET" ]; then
  echo "timed out waiting $wait_seconds seconds for the herdr-core socket at $HC_SOCKET with HERDR_CORE_DIRS=$HERDR_CORE_DIRS" >&2
  kill -TERM "$pid" 2>/dev/null || true
  for attempt in $(seq 1 10); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
  exit 1
fi
lsof -a -p "$pid" -U > "$proof/app-sockets"
lsof -U 2>/dev/null | grep -F "$live" > "$proof/live-sockets-during" || true
if grep -F "$live_state/herdr-core" "$proof/app-sockets" >/dev/null || [ "$(wc -l < "$proof/live-sockets-before")" -ne "$(wc -l < "$proof/live-sockets-during")" ]; then
  echo "scratch App may be attached to live core" >&2
  exit 1
fi
lsof -U 2>/dev/null | grep -F "$HC_SOCKET" > "$proof/core-sockets" || true
export SCRATCH_APP_BIN=$app
export SCRATCH_APP_PID=$pid
"$@"
