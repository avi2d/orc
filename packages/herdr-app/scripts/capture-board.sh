#!/bin/bash
set -euo pipefail
if [ "$#" -ne 2 ]; then
  echo "usage: capture-board.sh <fixture-dir> <output-png>" >&2
  exit 2
fi
fixture=$1
output=$2
if [ ! -d "$fixture/backlog" ]; then
  echo "fixture has no backlog dir: $fixture" >&2
  exit 1
fi
mkdir -p "$(dirname "$output")"
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
export ORC_HOME=$fixture
export HC_SOCKET=${HC_SOCKET:-$XDG_STATE_HOME/herdr-board-capture.sock}
if [ "${#HC_SOCKET}" -gt 103 ]; then
  echo "scratch core socket path length ${#HC_SOCKET} exceeds 103" >&2
  exit 1
fi
app=/Applications/Herdr.app/Contents/MacOS/Herdr
for tool in "$app" lsof osascript python3 /usr/sbin/screencapture; do
  if [ ! -x "$tool" ]; then
    echo "missing tool: $tool" >&2
    exit 1
  fi
done
proof=$HOME/herdr-board-capture-proof
mkdir -p "$proof"
lsof -U 2>/dev/null | grep -F "$live" > "$proof/live-sockets-before" || true
lsof -t "$live" 2>/dev/null | sort -un > "$proof/live-pids-before" || true
while read -r pid; do ps -p "$pid" -o pid=,lstart=; done < "$proof/live-pids-before" > "$proof/live-process-before"
if [ -f "$terminals" ]; then shasum -a 256 "$terminals" > "$proof/terminals-before"; else echo "missing" > "$proof/terminals-before"; fi
pid=
cleanup() {
  code=$?
  trap - EXIT
  set +e
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    if lsof -a -p "$pid" -U 2>/dev/null | grep -F "$HERDR_APP_HOME/herdr-app.sock" >/dev/null; then
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
"$app" > "$proof/app.log" 2>&1 </dev/null &
pid=$!
sleep 5
lsof -a -p "$pid" -U > "$proof/app-sockets"
grep -F "$HERDR_APP_HOME/herdr-app.sock" "$proof/app-sockets"
for attempt in $(seq 1 30); do [ -S "$HC_SOCKET" ] || sleep 1; done
lsof -U 2>/dev/null | grep -F "$live" > "$proof/live-sockets-during" || true
if grep -F "$live_state/herdr-core" "$proof/app-sockets" >/dev/null || [ "$(wc -l < "$proof/live-sockets-before")" -ne "$(wc -l < "$proof/live-sockets-during")" ]; then
  echo "scratch App may be attached to live core" >&2
  exit 1
fi
if [ -S "$HC_SOCKET" ]; then
  lsof -U 2>/dev/null | grep -F "$HC_SOCKET" > "$proof/core-sockets"
else
  echo "no scratch core socket" > "$proof/core-sockets"
fi
"$app" do layout.switch --name orc
osascript - "$pid" <<'OSA'
on run argv
  set appPid to (item 1 of argv) as integer
  tell application "System Events"
    set targetProcess to first application process whose unix id is appPid
    set frontmost of targetProcess to true
    delay 2
    tell targetProcess
      if (count of windows) is 0 then error "Scratch process has no accessible window"
      set value of attribute "AXMinimized" of window 1 to false
      set position of window 1 to {100, 80}
      set size of window 1 to {1400, 900}
    end tell
  end tell
end run
OSA
sleep 3
window=$(python3 - "$pid" <<'PY'
import ctypes
import plistlib
import sys
cg = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
cg.CGWindowListCopyWindowInfo.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
cg.CGWindowListCopyWindowInfo.restype = ctypes.c_void_p
cf.CFPropertyListCreateData.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int, ctypes.c_ulong, ctypes.c_void_p]
cf.CFPropertyListCreateData.restype = ctypes.c_void_p
cf.CFDataGetLength.argtypes = [ctypes.c_void_p]
cf.CFDataGetLength.restype = ctypes.c_long
cf.CFDataGetBytePtr.argtypes = [ctypes.c_void_p]
cf.CFDataGetBytePtr.restype = ctypes.c_void_p
array = cg.CGWindowListCopyWindowInfo(0, 0)
data = cf.CFPropertyListCreateData(None, array, 100, 0, None)
windows = plistlib.loads(ctypes.string_at(cf.CFDataGetBytePtr(data), cf.CFDataGetLength(data)))
for entry in windows:
    if entry.get("kCGWindowOwnerPID") != int(sys.argv[1]):
        continue
    bounds = entry.get("kCGWindowBounds", {})
    if bounds.get("Width", 0) >= 1200 and bounds.get("Height", 0) >= 750 and entry.get("kCGWindowLayer") == 0:
        print(entry["kCGWindowNumber"])
        break
else:
    raise SystemExit("Scratch App has no full-size window")
PY
)
/usr/sbin/screencapture -l "$window" -x "$output"
file "$output"
