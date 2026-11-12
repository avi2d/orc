import { Duration, Effect } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { Argv } from "../../shared/sandbox/index"
import { collectOutput } from "../../shared/process/index"
import { textInput } from "../../shared/sandbox/index"
import { providerEnvOf } from "../../shared/config/index"
import { readOrcConfig } from "../../shared/config/index"
import { deciderTimeoutMillis } from "../../entities/attention/index"
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
    const { stdout, stderr, exitCode } = yield* collectOutput(handle)
    if (exitCode !== 0) {
      return yield* new DeciderUnheard({ reason: "pi exited " + exitCode + ": " + stderr.trim().slice(-200) })
    }
    return stdout
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({ duration: Duration.millis(deciderTimeoutMillis), orElse: () => Effect.fail(new DeciderUnheard({ reason: "pi gave no reply in " + deciderTimeoutMillis / 1000 + " seconds" })) }),
    Effect.catchTag("PlatformError", (error) => Effect.fail(new DeciderUnheard({ reason: "pi did not run: " + error.message })))
  )
