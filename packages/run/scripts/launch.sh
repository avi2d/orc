#!/bin/sh
set -f

case "$0" in
  /*) entry=$0 ;;
  *) entry=$PWD/$0 ;;
esac
script=$entry
readlink=readlink
if [ -x /usr/bin/readlink ]; then
  readlink=/usr/bin/readlink
fi
while [ -L "$script" ]; do
  target=$("$readlink" "$script") || exit 1
  case "$target" in
    /*) script=$target ;;
    *) script=${script%/*}/$target ;;
  esac
done

find_runtime() (
  IFS=:
  for dir in ${PATH-}; do
    # A runtime shim would call this launcher again.
    case "$dir" in
      */heavy/bin|*/heavy/ci-only) continue ;;
    esac
    candidate=${dir:-.}/$1
    if [ -f "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  return 1
)

node=$(find_runtime node) || { echo 'orc: Node.js is required for the npm launcher' >&2; exit 127; }
ORC_LAUNCHER_ENTRY=$entry
ORC_LAUNCHER_BUN=$(find_runtime bun)
export ORC_LAUNCHER_ENTRY ORC_LAUNCHER_BUN

unset ORC_LAUNCHER_RESTORE
if [ "${1-}" = "--orc-standin" ]; then
  # Node reads these before the script runs; only the real tool gets the caller's values.
  for key in NODE_OPTIONS NODE_PATH NODE_PRESERVE_SYMLINKS NODE_PRESERVE_SYMLINKS_MAIN NODE_EXTRA_CA_CERTS NODE_REDIRECT_WARNINGS NODE_V8_COVERAGE NODE_COMPILE_CACHE OPENSSL_CONF SSL_CERT_FILE SSL_CERT_DIR; do
    if eval '[ "${'"$key"'+yes}" = yes ]'; then
      eval 'export "_ORC_CALLER_'"$key"'=${'"$key"'}"'
      ORC_LAUNCHER_RESTORE="${ORC_LAUNCHER_RESTORE-} $key"
      unset "$key"
    fi
  done
  export ORC_LAUNCHER_RESTORE
fi

exec "$node" "${script%/*}/launch.js" "$@"
