import { Effect, FileSystem, Path } from "effect"
import { root, runPlannedStepsAndExit } from "./run-steps"

const inherited = process.env
const home = root + ".orc-home"
// The default pack sits in the person's own home, not in the HOME the tools get.
const secretsPack = inherited["CHECKS_SECRETS_PACK"] ?? (inherited["HOME"] ?? "") + "/.config/checks/secrets-pack.json"

const nodeExecPath = (node: string | null): Effect.Effect<string> =>
  node === null
    ? Effect.succeed("")
    : Effect.promise(() => new Response(Bun.spawn([node, "-p", "process.execPath"], { stdout: "pipe", stderr: "inherit" }).stdout).text()).pipe(
      Effect.map((text) => text.trim())
    )

const planned = Effect.gen(function*() {
  const path = yield* Path.Path
  yield* (yield* FileSystem.FileSystem).makeDirectory(home, { recursive: true }).pipe(Effect.orDie)
  const runtimeBins = path.dirname(process.execPath) + ":" + path.dirname(yield* nodeExecPath(Bun.which("node")))
  return [{
    command: [],
    env: { ...inherited, CHECKS_SECRETS_PACK: secretsPack, HOME: home, PATH: root + "packages/run/scripts:" + runtimeBins + ":" + (inherited["PATH"] ?? "") }
  }]
})

runPlannedStepsAndExit(planned)
