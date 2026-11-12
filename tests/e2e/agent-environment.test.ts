import { expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { hostExec, shellInAgent } from "../../packages/run/src/shared/sandbox/agent-exec"

test("host checks keep the executing machine's runtime directory instead of losing its service sockets", async () => {
  const exec = hostExec(process.cwd(), {
    PATH: "/usr/bin:/bin",
    XDG_RUNTIME_DIR: "/run/user/1234",
    UNRELATED_SECRET: "not-for-the-child"
  }, {})
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return yield* shellInAgent(spawner, exec, 'printf "%s\\n%s\\n" "$XDG_RUNTIME_DIR" "${UNRELATED_SECRET-unset}"')
  })).pipe(Effect.provide(BunServices.layer)))
  expect(result).toEqual({ exitCode: 0, stdout: "/run/user/1234\nunset\n", stderr: "" })
})
