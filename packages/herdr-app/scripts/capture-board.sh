#!/bin/bash
set -euo pipefail
if [ "$#" -lt 2 ] || [ "$#" -gt 4 ]; then
  echo "usage: capture-board.sh <fixture-dir> <output-png> [orc-board|orc-resources|orc-agents|orc-inbox] [selected-task]" >&2
  exit 2
fi
fixture=$1
output=$2
view=${3:-orc-board}
selected=${4:-}
case "$view" in
  orc-board | orc-resources | orc-agents | orc-inbox) ;;
  *)
    echo "unknown view: $view" >&2
    exit 2
    ;;
esac
if [ ! -d "$fixture/backlog" ]; then
  echo "fixture has no backlog dir: $fixture" >&2
  exit 1
fi
mkdir -p "$(dirname "$output")"
if [ "$HOME" = "$(eval echo "~$(id -un)")" ]; then
  echo "HOME is the login home; run with a scratch HOME" >&2
  exit 1
fi
app_home=${HERDR_APP_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-app}
mkdir -p "$app_home"
shared=$app_home/shared.json
[ -f "$shared" ] || echo '{}' > "$shared"
jq --arg task "$selected" 'if $task == "" then del(."orc.board.selected") else ."orc.board.selected" = $task end' "$shared" > "$shared.tmp" && mv "$shared.tmp" "$shared"
# orc writes its database into ORC_HOME, so the capture reads a copy of the fixture.
ORC_HOME=$(mktemp -d "$HOME/orc-home.XXXXXX")
cp -RL "$fixture/." "$ORC_HOME"
export ORC_HOME
scripts=$(cd "$(dirname "$0")" && pwd)
ORC_CAPTURE_REAL=$(command -v orc) || { echo "orc is not on PATH" >&2; exit 1; }
export ORC_CAPTURE_REAL
export PATH=$scripts/capture-orc:$PATH
exec "$scripts/with-scratch-app.sh" "$scripts/capture-view.sh" "$view" "$output"
