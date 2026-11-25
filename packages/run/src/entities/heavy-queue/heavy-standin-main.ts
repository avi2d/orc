import { resolveCiOnly, runStandin, waitOwned } from "./heavy-standin-exec"
import { ciOnlyPathWord, ciOnlyWord, waiterWord } from "./heavy-standin-runtime"
import { refusedPathCall } from "./heavy-standin-refusal"

export const isStandinInvocation = (first: string): boolean =>
  first.startsWith("{") || first === waiterWord || first === ciOnlyWord || first === ciOnlyPathWord

export const runStandinInvocation = async ([first = "", ...rest]: ReadonlyArray<string>): Promise<number> => {
  if (first === ciOnlyPathWord) {
    return refusedPathCall(rest[0] ?? "", process.cwd()) ? 1 : 0
  }
  return first === waiterWord ? await waitOwned(rest) : first === ciOnlyWord ? resolveCiOnly(rest) : await runStandin(first, rest)
}

if (import.meta.main) {
  process.exitCode = await runStandinInvocation(process.argv.slice(2))
}
