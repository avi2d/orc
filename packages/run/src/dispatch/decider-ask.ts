import { Duration, Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { Argv } from "../agent-exec"
import { textInput } from "../agent-exec"
import { providerEnvOf } from "../model-route"
import { readOrcConfig } from "../orc-config"
import { deciderTimeoutMillis } from "./attention"
import { type AskDecider, DeciderUnheard } from "./decider"

// The policy replaces Pi's coding prompt and the call gets no tools, so the decider only reads the question and replies.
const deciderArgv = (model: string, policy: string): Argv => [
  "pi", "-p", "--mode", "text", "--no-session", "--no-tools", "--no-skills", "--no-context-files",
  "--model", model, "--thinking", "low", "--system-prompt", policy
]

export const askDeciderWithPi = (home: string): AskDecider => (request) =>
  Effect.gen(function*() {
    const config = yield* readOrcConfig(home).pipe(Effect.mapError((error) => new DeciderUnheard({ reason: error.file + ": " + error.detail })))
    const model = config.models?.decider
    if (model === undefined) {
      return yield* new DeciderUnheard({ reason: config.file + " names no models.decider" })
    }
    const [program, ...args] = deciderArgv(model, request.policy)
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    // extendEnv lays this over the shell's environment, so the provider's env wins over an exported variable.
    const handle = yield* spawner.spawn(ChildProcess.make(program, args, { cwd: home, env: providerEnvOf(config, model), extendEnv: true, stdin: textInput(request.prompt) }))
    const [stdout, stderr, exitCode] = yield* Effect.all([
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      handle.exitCode
    ], { concurrency: "unbounded" })
    if (exitCode !== 0) {
      return yield* new DeciderUnheard({ reason: "pi exited " + exitCode + ": " + stderr.trim().slice(-200) })
    }
    return stdout
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({ duration: Duration.millis(deciderTimeoutMillis), orElse: () => Effect.fail(new DeciderUnheard({ reason: "pi gave no reply in " + deciderTimeoutMillis / 1000 + " seconds" })) }),
    Effect.catchTag("PlatformError", (error) => Effect.fail(new DeciderUnheard({ reason: "pi did not run: " + error.message })))
  )
