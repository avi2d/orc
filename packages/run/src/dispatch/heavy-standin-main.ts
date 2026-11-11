import { classifyHeavyCall, decisionWords } from "./heavy-classify"
import { parseStandinCall, planCall, planWords, queueCall } from "./heavy-standin-runtime"

const [mode = "", settings = "", ...rest] = process.argv.slice(2)
const call = parseStandinCall(settings)
if (call === null) {
  process.stderr.write("orc heavy: the stand-in holds no readable call settings; rerun orc to rewrite it\n")
  process.exitCode = 2
} else if (mode === "classify") {
  process.stdout.write(decisionWords(classifyHeavyCall(call.tool, call.commands, rest)) + "\n")
} else if (mode === "plan") {
  const [standin = "", ...args] = rest
  process.stdout.write(planWords(planCall(call, standin, args)) + "\n")
} else if (mode === "queue") {
  const [real = "", ...args] = rest
  process.exitCode = await queueCall(call, real, args)
} else {
  process.stderr.write("orc heavy: the stand-in asked for an unknown step " + mode + "; rerun orc to rewrite it\n")
  process.exitCode = 2
}
