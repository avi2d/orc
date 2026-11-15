#!/bin/bash
set -euo pipefail
if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: capture-board.sh <fixture-dir> <output-png> [orc-board|orc-resources|orc-agents]" >&2
  exit 2
fi
fixture=$1
output=$2
view=${3:-orc-board}
case "$view" in
  orc-board | orc-resources | orc-agents) ;;
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
export ORC_HOME=$fixture
scripts=$(dirname "$0")
exec "$scripts/with-scratch-app.sh" "$scripts/capture-view.sh" "$view" "$output"
