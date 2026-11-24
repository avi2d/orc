import { ciOnlyBinDir, heavyBinDir } from "./heavy"
import { quoteSingle } from "./heavy-standin"
import { standinMarker } from "./heavy-standin-runtime"

const wrappedAgents: ReadonlyArray<string> = ["claude", "codex", "opencode", "pi"]

const agentWrapperMarker = standinMarker + " agent wrapper"

// The agent search walks the caller's PATH, not the stand-in folders put ahead of it, so a heavy command named like the agent never starts in its place.
const agentWrapperScript = (agent: string, home: string): string => {
  const missing = "orc heavy: no " + agent + " on PATH after this wrapper"
  return `#!/bin/sh
# ${agentWrapperMarker}. Regenerated on every run of that command.
caller_path=$PATH
HEAVY_TESTS_CI_ONLY=1
PATH=${quoteSingle(ciOnlyBinDir(home) + ":" + heavyBinDir(home))}:"$PATH"
export HEAVY_TESTS_CI_ONLY PATH
set -f
IFS=:
for dir in $caller_path; do
  [ -n "$dir" ] && [ -x "$dir"/${quoteSingle(agent)} ] && ! [ "$dir"/${quoteSingle(agent)} -ef "$0" ] && exec "$dir"/${quoteSingle(agent)} "$@"
done
echo ${quoteSingle(missing)} >&2
exit 127
`
}

export const agentWrapperScripts = (home: string): Record<string, string> =>
  Object.fromEntries(wrappedAgents.map((agent) => [agent, agentWrapperScript(agent, home)]))
