#!/bin/bash
set -euo pipefail
if [ "$#" -ne 2 ] || [ -z "${SCRATCH_APP_BIN:-}" ]; then
  echo "usage: with-scratch-app.sh capture-view.sh <view> <output-png>" >&2
  exit 2
fi
view=$1
output=$2
"$SCRATCH_APP_BIN" do layout.switch --name orc
"$SCRATCH_APP_BIN" do layout.select "{\"stack\":\"orc-views\",\"child\":\"$view\"}"
sleep 3
"$SCRATCH_APP_BIN" shot "$output"
file "$output"
