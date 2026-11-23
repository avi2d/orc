#!/bin/bash
set -euo pipefail
if [ "$#" -ne 0 ]; then
  echo "usage: try-bb.sh" >&2
  exit 2
fi
version=0.50.1
dmg_sha=94388d439f6a1b81b00e5e1819c031f112b5188115cd23fb91f1d3c9da1e4a1f
port=38986
here=$(cd "$(dirname "$0")" && pwd)
plugin=$here/plugin
real_home=$(eval echo "~$(id -un)")
prefs=$real_home/Library/Preferences/dev.bb.desktop.plist
if [ -e "$prefs" ] || [ -L "$prefs" ]; then
  echo "refusing to run while $prefs exists" >&2
  exit 1
fi
real_data=("$real_home/.bb" "$real_home/Library/Application Support/bb" "$prefs")
scratch=$here/.scratch
for tool in curl hdiutil ditto shasum jq lsof sqlite3 orc screencapture; do
  if ! command -v "$tool" >/dev/null; then
    echo "missing tool: $tool" >&2
    exit 1
  fi
done
if pgrep -f "/bb.app/Contents/MacOS/bb" >/dev/null; then
  echo "another bb is running; quit it so the real bb data stays still while the trial compares it" >&2
  exit 1
fi
if lsof -nP -iTCP:"$port" -iTCP:"$((port + 1))" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $port or $((port + 1)) is taken; stop the process using it and run again" >&2
  exit 1
fi
app=$scratch/bb.app
data=$scratch/data
user_data=$scratch/user-data
proof=$scratch/proof
mkdir -p "$data" "$user_data" "$proof" "$scratch/home"
snapshot() {
  for path in "${real_data[@]}"; do
    if [ -e "$path" ]; then
      find "$path" -type f -print0 | sort -z | xargs -0 shasum -a 256
    else
      echo "missing $path"
    fi
  done
}
snapshot > "$proof/real-before"
if [ ! -d "$app" ]; then
  dmg=$scratch/bb-$version-arm64.dmg
  [ -f "$dmg" ] || curl -fL --retry 3 -o "$dmg" "https://github.com/get-bb/bb/releases/download/desktop-v$version/bb-$version-arm64.dmg"
  echo "$dmg_sha  $dmg" | shasum -a 256 -c - >/dev/null
  mount=$scratch/dmg
  mkdir -p "$mount"
  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mount" "$dmg" >/dev/null
  ditto "$mount/bb.app" "$app"
  hdiutil detach "$mount" >/dev/null
fi
installed=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$app/Contents/Info.plist")
if [ "$installed" != "$version" ]; then
  echo "scratch bb.app is $installed, not $version; remove $app and run again" >&2
  exit 1
fi
export ORC_HOME=${ORC_HOME:-$real_home/.orc}
export HOME=$scratch/home
export BB_DATA_DIR=$data
export BB_SERVER_PORT=$port
export BB_HOST_DAEMON_PORT=$((port + 1))
export BB_SERVER_URL=http://127.0.0.1:$port
export BB_TELEMETRY=false
export BB_SKIP_ONBOARDING=1
pid=
stop_bb() {
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid"
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  fi
  for child in $(lsof -t -nP -iTCP:"$port" -iTCP:"$((port + 1))" -sTCP:LISTEN 2>/dev/null); do
    case "$(ps -p "$child" -o command=)" in
      "$app/"*) kill -TERM "$child" ;;
    esac
  done
}
cleanup() {
  code=$?
  trap - EXIT
  set +e
  stop_bb
  # Electron sets its launch defaults through NSUserDefaults, which writes under the login home whatever HOME says.
  if [ -e "$prefs" ]; then
    defaults delete dev.bb.desktop >/dev/null 2>&1
    rm -f "$prefs"
    echo "removed $prefs, which Electron wrote at launch and the trial found missing"
  fi
  snapshot > "$proof/real-after"
  if cmp -s "$proof/real-before" "$proof/real-after"; then
    echo "real bb data untouched: ${real_data[*]}"
  else
    echo "real bb data changed; compare $proof/real-before with $proof/real-after" >&2
    code=1
  fi
  exit "$code"
}
trap cleanup EXIT
# Electron keeps its own state, the Connect credential cache among it, in the userData folder, which BB_DATA_DIR does not move.
# Chromium otherwise stores its cookie key in the login keychain, which no scratch HOME reaches.
"$app/Contents/MacOS/bb" --user-data-dir="$user_data" --use-mock-keychain > "$proof/bb.log" 2>&1 &
pid=$!
cli=$data/bin/bb
for _ in $(seq 1 120); do
  status=$(curl -s -o /dev/null -w '%{http_code}' "$BB_SERVER_URL/" || true)
  [ "$status" != "000" ] && [ -x "$cli" ] && break
  kill -0 "$pid" 2>/dev/null || { echo "bb exited; see $proof/bb.log" >&2; exit 1; }
  sleep 0.5
done
if [ ! -x "$cli" ] || [ "$status" = "000" ]; then
  echo "timed out waiting 60 seconds for the bb server at $BB_SERVER_URL" >&2
  exit 1
fi
"$cli" settings general telemetryEnabled false >/dev/null
"$cli" settings show --json > "$proof/settings.json"
jq -e '.generalSettings.telemetryEnabled == false' "$proof/settings.json" >/dev/null
echo "telemetryEnabled is false in $proof/settings.json, and BB_TELEMETRY=false held from the first start"
"$cli" plugin install "$plugin" --yes >/dev/null
"$cli" plugin rpc call orc-board board | jq -S . > "$proof/page.json"
orc backlog --json | jq -S '{ kind: "ok", tasks: [.tasks[] | { id, title }] }' > "$proof/cli.json"
if ! cmp -s "$proof/page.json" "$proof/cli.json"; then
  echo "the plugin read differs from orc backlog --json; compare $proof/page.json with $proof/cli.json" >&2
  exit 1
fi
echo "the plugin reads the same $(jq '.tasks | length' "$proof/cli.json") tasks as orc backlog --json"
echo "Open orc Board in bb's navigation rail, then press Enter to take the screenshot."
read -r
window=$(osascript -l JavaScript -e "ObjC.import('CoreGraphics')
const windows = ObjC.deepUnwrap(ObjC.castRefToObject(\$.CGWindowListCopyWindowInfo(\$.kCGWindowListOptionOnScreenOnly, 0)))
const bb = windows.find((w) => w.kCGWindowOwnerPID === $pid && w.kCGWindowLayer === 0)
bb === undefined ? '' : String(bb.kCGWindowNumber)")
shot=failed
if [ -z "$window" ]; then
  echo "found no bb window on screen to capture" >&2
elif ! screencapture -o -x -l"$window" "$proof/board.png"; then
  echo "could not capture the bb window; give this terminal the Screen Recording permission" >&2
else
  shot=saved
  echo "screenshot saved to $proof/board.png"
fi
stop_bb
find "$scratch/home" "$data" "$user_data" \( -name connect-credential.bin -o -name env.json \) -print > "$proof/account-files"
find "$user_data" -type f -name Cookies -print0 | while IFS= read -r -d '' cookies; do
  sqlite3 -readonly "$cookies" "select host_key from cookies where host_key like '%getbb.app'" | sed "s|^|$cookies: |"
done >> "$proof/account-files"
sqlite3 -readonly "$data/bb.db" "select 'bb.db user ' || email from user where id != 'bb-machine-auth-system-user'" >> "$proof/account-files"
if [ -s "$proof/account-files" ]; then
  echo "the scratch folder holds an account or credential; see $proof/account-files" >&2
  exit 1
fi
echo "no Connect credential, getbb.app sign-in cookie, bb.db user or provider env.json in $scratch"
[ "$shot" = saved ]
