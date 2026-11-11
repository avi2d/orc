import { classifyHeavyCall, decisionWords, parseClassifyArgv } from "./heavy-classify"

const call = parseClassifyArgv(process.argv.slice(2))
if (call === null) {
  process.stderr.write("orc heavy: the stand-in holds no readable call settings; rerun orc to rewrite it\n")
  process.exitCode = 2
} else {
  process.stdout.write(decisionWords(classifyHeavyCall(call.request.tool, call.request.commands, call.args)) + "\n")
}
