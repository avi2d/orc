import { resolveCiOnly, runStandin, waitOwned } from "./heavy-standin-exec"
import { ciOnlyWord, waiterWord } from "./heavy-standin-runtime"

const [first = "", ...rest] = process.argv.slice(2)
process.exitCode = first === waiterWord ? await waitOwned(rest) : first === ciOnlyWord ? resolveCiOnly(rest) : await runStandin(first, rest)
