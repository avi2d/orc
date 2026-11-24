import { resolveCiOnly, runStandin, waitOwned } from "./heavy-standin-exec"
import { ciOnlyPathWord, ciOnlyWord, waiterWord } from "./heavy-standin-runtime"
import { refusedPathCall } from "./heavy-standin-refusal"

const [first = "", ...rest] = process.argv.slice(2)
if (first === ciOnlyPathWord) {
  if (refusedPathCall(rest[0] ?? "", process.cwd())) {
    process.exitCode = 1
  }
} else {
  process.exitCode = first === waiterWord ? await waitOwned(rest) : first === ciOnlyWord ? resolveCiOnly(rest) : await runStandin(first, rest)
}
