import { runStandin, waitOwned } from "./heavy-standin-exec"
import { waiterWord } from "./heavy-standin-runtime"

const [first = "", ...rest] = process.argv.slice(2)
process.exitCode = (first === waiterWord ? await waitOwned(rest) : await runStandin(first, rest))
